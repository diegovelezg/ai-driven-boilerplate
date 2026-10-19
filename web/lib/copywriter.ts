// Copywriter (Proponer, Fase A): por señal `prioritized` redacta
// WhatsApp/email con historial real → `proposed_actions` `pending_review`.
// Nunca envía: el humano aprueba en /review y el dispatcher ejecuta.
// LLM vía proceso `proposer_draft` (primario → fallback). Corre en
// background con `background_runs` kind `copywriter`.
import { getSupabase } from "@/lib/supabase";
import { getRankedMira } from "@/lib/mira";
import { JUDGE_GEN, judgeContactability, type JudgeItem } from "@/lib/contactability";
import { JUDGE_VETO_PREFIX } from "@/lib/single-audit";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { getStoreProfile, type CatalogType } from "@/lib/store-profiles";
import { chatCompletionParams, getLlmConfig, reasoningBody, type ModelRef } from "@/lib/ai/llm-config";

const log = createLogger("copywriter");

/** Versión del criterio generador. Sube cuando cambia el prompt/reglas:
 *  el regenerador solo rehace pendientes con sello viejo. */
import { COPYWRITER_GEN } from "./copywriter-gen";

export { COPYWRITER_GEN };

/** Sustantivo neutro para el brief según catálogo (el LLM repite esta palabra).
 *  Sin esto, todo tenant suena a vía pública ("pauta", "circuito", "zona"). */
export function briefNoun(catalog: CatalogType | null): {
  last: string;
  repeat: string;
  empty: string;
} {
  switch (catalog) {
    case "servicio":
    case "digital":
      return { last: "Última contratación", repeat: "suele contratar", empty: "contratación sin detalle" };
    default:
      return { last: "Última compra", repeat: "suele comprar", empty: "compra sin detalle" };
  }
}
/** Verbo de compra según qué vende el tenant. Sin esto, el redactor habla
 *  como bodega (“llevaste un Rp Cajamarca”) aunque venda espacios/servicios. */
export function purchaseLanguage(
  catalog: CatalogType | null,
  vertical: string | null,
): string {
  const v = (vertical ?? "").trim().slice(0, 120);
  switch (catalog) {
    case "servicio":
      return `El negocio es un SERVICIO${v ? ` (${v})` : ""}: el cliente contrata/reserva/publica, NO lleva objetos. Usa “contrataste tu campaña en X”, “publicaste en X”, “tu última pauta”. PROHIBIDO: llevar, llevarte, recoger, lucir, estrenar, “visitar la tienda”.`;
    case "digital":
      return `El negocio es DIGITAL${v ? ` (${v})` : ""}: el cliente contrata/accede/descarga. PROHIBIDO: llevar, recoger, visitar.`;
    case "consumible":
    case "perecedero":
      return `El negocio vende productos de reposición${v ? ` (${v})` : ""}: “llevaste / volviste por X” está bien.`;
    case "moda_estacional":
      return `El negocio vende moda/temporada${v ? ` (${v})` : ""}: “llevaste / estrenaste X” está bien.`;
    case "durable":
      return `El negocio vende bienes durables${v ? ` (${v})` : ""}: usa “compraste/adquiriste X”. Evita “llevaste” si suena a bodega.`;
    default:
      return `Negocio sin tipificar${v ? ` (${v})` : ""}: usa neutro (“tu última compra/contratación en X”). PROHIBIDO: llevar, recoger.`;
  }
}

const SYSTEM = `Redactas mensajes de recupero 1-a-1 para el negocio descrito abajo (español Perú, directo, profesional, cero cursi).
Responde SOLO con un objeto JSON válido, sin markdown, con este esquema exacto:
{"channel": "whatsapp"|"email", "subject": string|null, "body": string}
Reglas (solo restricciones; la forma la eliges tú y debe variar entre borradores: aperturas, orden y cierres distintos):
- Usa los datos de respaldo solo si encajan natural en una frase sobre el negocio del cliente: PROHIBIDO recitar fecha+lugar como telegrama. Toda cifra o lugar debe aparecer dentro de una frase sobre su negocio (qué vende, a quién, en qué temporada). PROHIBIDO inventar datos, meses, ofertas, descuentos o ubicaciones.
- PROHIBIDAS las frases de plantilla y call center (hay control automático: si las usas el borrador se rechaza).
- PROHIBIDA la pregunta abierta vaga y el ruego. Cierra con UNA propuesta accionable de máximo 15 palabras, con tu propia fórmula.
- Nunca menciones score, media, ciclo, arquetipo ni cifras internas: solo lo que el cliente reconocería.
- Tono por objetivo (viene en el brief): vip_care = leal, trato 1-a-1. nurture = hábito cortado, una lectura útil. winback = simple, baja fricción.
- Empieza con "Hola {primer nombre}," (solo primer nombre, nunca apellido ni email).
- Voz: primera persona singular + tuteo. PROHIBIDO "reservamos/preparamos" o el trato de usted.
- whatsapp: máximo 400 caracteres, sin asunto (subject null). email: subject corto + body de máximo 1200 caracteres.
- Un solo mensaje, listo para enviar. Sin placeholders tipo [NOMBRE].`;

/** Frases plantilla que delatan al redactor genérico: si el borrador las
 *  trae, se reintenta una vez con nudge; si persiste, se descarta. */
const BANNED = [
  "revisar opciones",
  "estamos aquí para ayudarte",
  "estamos aqui para ayudarte",
  "si estás pensando en volver a pautar",
  "si estas pensando en volver a pautar",
  "planificar tu próxima campaña",
  "¿te interesa?",
  "¿te gustaria retomarlo?",
  "¿te gustaría retomarlo?",
  "se interrumpió el ritmo",
  "se interrumpio el ritmo",
  "muestran un patrón claro",
  "muestran un patron claro",
  "tu última pauta fue",
  "tu ultima pauta fue",
];

function hasBanned(body: string): boolean {
  const b = body.toLowerCase();
  return BANNED.some((p) => b.includes(p));
}

/** El ancla se verifica por código (fecha o lugar del brief presente en el
 *  texto), no por posición: el modelo decide dónde ponerla. */
function hasAnchor(body: string, tokens: Array<string | null>): boolean {
  const b = body.toLowerCase();
  return tokens.some((t) => !!t && t.length >= 4 && b.includes(t.toLowerCase()));
}

/** El juez dijo no-contactable: no es un fallo (no suma a failed), es una
 *  omisión auditada. Lleva el motivo para el log y el flag en evidence. */
export class ContactabilitySkip extends Error {}

/** "sin comprar hace 219d (media 60d, 2 compras, ciclo arquetipo)" → partes.
 *  Acepta también el formato retention:v1
 *  "sin comprar hace 38d (ciclo ~30d, vuelve típicamente entre 25–37d)". */
function parseReason(reason: string | null): {
  days: number | null;
  expected: number | null;
  source: string | null;
} {
  if (!reason) return { days: null, expected: null, source: null };
  const m = reason.match(/sin comprar hace (\d+)d\s*\(media (\d+)d,[^,]*,\s*ciclo (\w+)\)/i);
  if (m) return { days: Number(m[1]), expected: Number(m[2]), source: m[3] };
  const n = reason.match(/sin comprar hace (\d+)d\s*\(ciclo ~(\d+)d/i);
  if (n) return { days: Number(n[1]), expected: Number(n[2]), source: null };
  const d = reason.match(/sin comprar hace (\d+)d/i);
  return { days: d ? Number(d[1]) : null, expected: null, source: null };
}

/** Fecha "2025-04-06" → "6 de abril" (lo que el cliente reconoce). */
function fechaCorta(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return null;
  const meses = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];
  return `${d.getDate()} de ${meses[d.getMonth()]}`;
}

async function completeJson(
  ref: ModelRef,
  temp: number,
  maxTokens: number,
  effort: string | null,
  system: string,
  user: string,
): Promise<string> {
  const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
  if (!apiKey) throw new Error(`Falta ${ref.apiKeyEnv}`);
  const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: ref.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...chatCompletionParams(ref.provider, ref.model, temp, maxTokens),
    response_format: { type: "json_object" },
    ...reasoningBody(ref.provider, ref.model, effort),
  };
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${ref.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error(`${ref.provider}: respuesta vacía`);
  return content;
}

async function draft(system: string, user: string): Promise<string> {
  const cfg = getLlmConfig("proposer_draft");
  try {
    return await completeJson(cfg.primary, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user);
  } catch (e) {
    if (!cfg.fallback) throw e;
    log(`primario ${cfg.primary.model} falló (${e instanceof Error ? e.message : e}); fallback a ${cfg.fallback.model}`);
    return await completeJson(cfg.fallback, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user);
  }
}

export interface CopywriterOpts {
  /** Máx. borradores por corrida (control de coste LLM). */
  limit?: number;
}

interface Prioritized {
  id: string;
  kind: string;
  /** Tratamiento (issue #11): strategist escribe objective; kind se conserva como origen. */
  objective?: string | null;
  score: number | null;
  reason: string | null;
  customer_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  /** Empresa del cliente (company_name; dossier-first la abre). */
  companyName?: string | null;
  /** ISO2 atribuido (filtro global; se escribe en la acción). */
  country: string | null;
  /** Motor retention:v1 (para estratificar el holdout futuro). */
  decision?: string | null;
  pRecompraH?: number | null;
}

type Db = ReturnType<typeof getSupabase>;

/** System prompt con el lenguaje de compra del tenant (1 query, reutilizable). */
async function buildSystem(storeId: string): Promise<{ system: string; catalog: CatalogType | null }> {
  const profile = await getStoreProfile(storeId).catch(() => null);
  const langLine = purchaseLanguage(profile?.catalogType ?? null, profile?.verticalDetected ?? null);
  return { system: `${SYSTEM}\nLenguaje del negocio: ${langLine}`, catalog: profile?.catalogType ?? null };
}

/** Redacta UN borrador para la señal (historial real → LLM → insert → actioned). Lanza si falla. */
async function draftForSignal(
  db: Db,
  storeId: string,
  system: string,
  s: Prioritized,
  stamp: { runId: string | null; catalog: CatalogType | null },
): Promise<{ channel: string; chars: number }> {
  const { data: orders } = await db
    .from("orders")
    .select("total_amount,currency,placed_at,items_json,status,payment_status,is_test")
    .eq("customer_id", s.customer_id)
    .order("placed_at", { ascending: false })
    .limit(10);
  const { isRealDbOrder } = await import("@/lib/medusa");
  const real = (((orders ?? []) as Array<Record<string, unknown>>).filter((o) =>
    isRealDbOrder({
      status: typeof o.status === "string" ? o.status : null,
      payment_status: typeof o.payment_status === "string" ? o.payment_status : null,
      is_test: o.is_test === true,
    }),
  )).slice(0, 5);
  // Historial legible: fecha corta + ubicaciones reales (sin "x0", sin moneda).
  // Enriquecido con media-context (misma forma para cualquier tenant):
  // contiene/categoría/pauta/clienteDijo/detalles solo si existen (sin nulls ruidosos).
  const { enrichOrderItems } = await import("@/lib/media-context");
  const rawPerOrder = real.map((o) =>
    ((o.items_json as Array<Record<string, unknown>>) ?? []).map((i) => ({
      title: String(i.title ?? "").trim(),
      quantity: Number(i.quantity ?? 0),
      metadata: (i.metadata as Record<string, unknown> | undefined) ?? undefined,
    })),
  );
  const enrichedFlat = await enrichOrderItems(storeId, rawPerOrder.flat());
  let cur = 0;
  const noun = briefNoun(stamp.catalog);
  const histLines = real.map((o, oi) => {
    const iso = String(o.placed_at ?? "?").slice(0, 10);
    const f = fechaCorta(String(o.placed_at ?? "")) ?? iso;
    const items = enrichedFlat.slice(cur, cur + rawPerOrder[oi].length);
    cur += rawPerOrder[oi].length;
    const titles = items.map((i) => i.title).filter((t) => t && t !== "—").slice(0, 4).join(" · ");
    const extras: string[] = [];
    for (const it of items.slice(0, 2)) {
      if (it.contiene) extras.push(`contiene "${it.contiene}"${it.categoria ? ` [${it.categoria}]` : ""}`);
      if (it.pauta) extras.push(`periodo ${it.pauta}`);
      if (it.clienteDijo) extras.push(`cliente dijo: "${it.clienteDijo.slice(0, 120)}"`);
      const det = Object.entries(it.detalles ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ");
      if (det) extras.push(det);
    }
    return `- ${f} (${iso}): ${titles || noun.empty}${extras.length > 0 ? ` — ${extras.join("; ")}` : ""}`;
  });
  const hist = histLines.join("\n") || "(sin compras visibles)";
  // Patrón del cliente: ¿repite circuito o explora? (top ubicación por frecuencia)
  const counts = new Map<string, number>();
  for (const o of real) {
    for (const i of ((o.items_json as Array<Record<string, unknown>>) ?? [])) {
      const t = String(i.title ?? "").trim();
      if (t && t !== "—") counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const distinct = counts.size;
  const r = parseReason(s.reason);
  const days = r.days;
  // Patrón cualitativo (sin conteos: evita sobredimensionar con n bajo).
  // El estado por ratio fija el tono; los números citables son solo fecha+lugar+silencio.
  const catCounts = new Map<string, number>();
  const marcaByCat = new Map<string, string>();
  for (const it of enrichedFlat) {
    if (it.categoria) {
      catCounts.set(it.categoria, (catCounts.get(it.categoria) ?? 0) + 1);
      const m = it.contiene?.split(":")[0]?.trim() ?? "";
      if (m && !marcaByCat.has(it.categoria)) marcaByCat.set(it.categoria, m);
    }
  }
  const topCat = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const ratio = days && r.expected ? days / r.expected : null;
  const estado =
    ratio === null
      ? "sin referencia de ritmo"
      : ratio < 3
        ? "pausa corta: tono de retoma natural"
        : ratio < 10
          ? "hábito cortado: nombra el quiebre"
          : "dormido: OBLIGATORIO abrir reconociendo el tiempo (ej. «sé que ha pasado más de un año»). PROHIBIDO escribir como si la pausa fuera reciente";
  const patron =
    topCat && topCat[1] >= 2
      ? `CONTENIDO: ${noun.repeat} "${topCat[0]}"${marcaByCat.get(topCat[0]) ? ` (ej. ${marcaByCat.get(topCat[0])})` : ""}. Tono: continuidad de su línea`
      : top && top[1] >= 2
        ? `REPITE: suele volver a "${top[0]}". Tono: volver a lo que le funciona`
        : distinct >= 3
          ? `EXPLORA: prueba opciones distintas. Tono: novedad`
          : top
            ? `última elección "${top[0]}"`
            : "sin patrón legible";
  const firstName = (s.first_name ?? "").trim().split(/\s+/)[0] || s.email;
  const lastIso = real[0] ? String(real[0].placed_at ?? "").slice(0, 10) : null;
  const lastF = real[0] ? (fechaCorta(String(real[0].placed_at ?? "")) ?? lastIso) : null;
  // Issue #11: el copywriter lee objective (tratamiento), no kind (origen).
  // Fallback a kind para señales pre-migración sin objective.
  const treatment = s.objective ?? s.kind;
  const objetivo =
    treatment === "vip_care"
      ? "vip_care: cliente leal, reconoce historial + oferta 1-a-1 concreta"
      : treatment === "winback"
        ? "winback: 1-2 compras, simple y baja fricción"
        : "nurture: tenía hábito y se cortó, nombra el quiebre + 1 lectura útil";

  // Menú de jugadas en lenguaje de invitación (disponibilidad, reserva,
  // temporada del rubro). Coherencia jugada↔BANNED (issue #9): la jugada ya
  // no ordena "repetir circuito con prioridad de espacios", así el BANNED
  // puede prohibir las muletillas sin fabricar descartes (el modelo obedece
  // al brief y el control lo rechaza → gasta el único reintento → failed++).
  // Neutro por catálogo: solo servicio/digital hablan de espacios/zonas.
  const jugada =
    stamp.catalog === "servicio" || stamp.catalog === "digital"
      ? patron.startsWith("CONTENIDO") || patron.startsWith("REPITE")
        ? "invitarle a reservar con prioridad según disponibilidad en su línea habitual, o avisarle de la temporada de su rubro"
        : patron.startsWith("EXPLORA")
          ? "invitarle a apartar un espacio que aún no prueba según disponibilidad, o a asegurar su mejor ubicación para la temporada"
          : "invitarle a retomar con una reserva simple según disponibilidad"
      : patron.startsWith("CONTENIDO") || patron.startsWith("REPITE")
        ? "invitarle a reservar su favorito habitual según disponibilidad, o a probar algo distinto de su línea en esta temporada"
        : patron.startsWith("EXPLORA")
          ? "invitarle a probar algo nuevo de su línea según disponibilidad, o a asegurar su favorito para la temporada"
          : "invitarle a retomar con una propuesta simple según disponibilidad";

  // Dossier-first (issue #9): quién es + por-qué-ahora abren; fecha/lugares
  // van a datos de respaldo ("úsalos solo si encajan natural"). company_name
  // hoy ni se leía en el brief: se trae del Prioritized o de customers.
  let companyName = (s.companyName ?? "").trim() || null;
  if (!companyName) {
    const { data: cRow } = await db
      .from("customers")
      .select("company_name")
      .eq("id", s.customer_id)
      .maybeSingle();
    const cn = (cRow as Record<string, unknown> | null)?.company_name;
    if (typeof cn === "string" && cn.trim()) companyName = cn.trim().slice(0, 120);
  }
  const marcas: string[] = [];
  const categorias: string[] = [];
  for (const it of enrichedFlat) {
    const m = it.contiene?.split(":")[0]?.trim() ?? "";
    if (m && m.length >= 3 && !marcas.includes(m)) marcas.push(m);
    if (it.categoria && !categorias.includes(it.categoria)) categorias.push(it.categoria);
  }
  const quien = companyName ?? marcas[0] ?? categorias[0] ?? null;
  const dossier = quien
    ? `Cliente: ${firstName} — ${quien}${companyName && marcas[0] && marcas[0] !== companyName ? ` (en sus piezas: ${marcas[0]}${categorias[0] ? ` · ${categorias[0]}` : ""})` : categorias[0] && categorias[0] !== quien ? ` (${categorias[0]})` : ""} (objetivo ${objetivo})`
    : `Cliente: ${firstName} (objetivo ${objetivo})`;

  const user = [
    dossier,
    `Por-qué-ahora en una línea: ${estado}. ${patron}.`,
    `Jugada (elige UNA, no las combines): ${jugada}.`,
    `Datos de respaldo (úsalos solo si encajan natural en una frase sobre su negocio, nunca como lista ni telegrama): ${noun.last} ${lastF ?? "?"}${lastIso ? ` (${lastIso})` : ""}, hace ${days ?? "?"} días.`,
    `Historial real (usa nombres tal cual, no inventes):`,
    hist,
    s.phone ? "Canal: whatsapp (tiene teléfono)." : "Canal: email (sin teléfono).",
  ].join("\n");

  const attempt = async (extraNudge: string | null): Promise<{ channel: string; body: string; subject: string | null }> => {
    const raw = await draft(system, extraNudge ? `${user}\n\nREINTENTO: ${extraNudge}` : user);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const channel = parsed.channel === "email" ? "email" : "whatsapp";
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    const subject = typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim().slice(0, 200) : null;
    return { channel, body, subject };
  };

  // Puerta de contactabilidad (issue #9): el juez LLM pone la sensatez con el
  // mismo dossier enriquecido del brief, ANTES de gastar el draft. Sin listas
  // en código: el modelo razona sobre contenido + ventanas + hoy.
  const winOf = (md: unknown, key: "dateStart" | "dateEnd"): string | null => {
    const m = (md as Record<string, unknown> | null) ?? null;
    const v = m?.[key];
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim()) ? v.trim().slice(0, 10) : null;
  };
  const flatMeta: Array<{ dateStart: string | null; dateEnd: string | null }> = [];
  rawPerOrder.forEach((arr) => {
    for (const r of arr) {
      flatMeta.push({ dateStart: winOf(r.metadata, "dateStart"), dateEnd: winOf(r.metadata, "dateEnd") });
    }
  });
  const judgeItems: JudgeItem[] = enrichedFlat.map((en, i) => ({
    title: en.title,
    contiene: en.contiene,
    categoria: en.categoria,
    clienteDijo: en.clienteDijo,
    dateStart: flatMeta[i]?.dateStart ?? null,
    dateEnd: flatMeta[i]?.dateEnd ?? null,
  }));
  const verdict = await judgeContactability({
    firstName,
    companyName,
    objetivo,
    daysSince: days,
    todayIso: new Date().toISOString().slice(0, 10),
    items: judgeItems,
  });
  if (!verdict.contactable) {
    // Flag auditado en la señal (sin estados ni columnas nuevas): por qué no
    // se redactó. La señal sigue prioritized; el próximo run rejuzga (el
    // contenido o el aniversario pueden cambiar el veredicto).
    try {
      const { data: sigRow } = await db
        .from("churn_signals")
        .select("evidence_json")
        .eq("id", s.id)
        .maybeSingle();
      const prev = ((sigRow as Record<string, unknown> | null)?.evidence_json as Record<string, unknown> | null) ?? {};
      await db
        .from("churn_signals")
        .update({
          evidence_json: {
            ...prev,
            contactability: {
              eligible: false,
              reason: verdict.reason,
              at: new Date().toISOString(),
              generator: JUDGE_GEN,
            },
          },
        })
        .eq("id", s.id);
    } catch {
      // El flag es auditoría: nunca bloquea la omisión.
    }
    throw new ContactabilitySkip(verdict.reason);
  }

  let { channel, body, subject } = await attempt(null);
  if (!body) throw new Error("El LLM devolvió body vacío.");
  if (hasBanned(body)) {
    const retry = await attempt("tu borrador anterior sonaba a plantilla genérica; reescribe con otra estructura y otras palabras, sin ninguna frase prohibida.");
    if (hasBanned(retry.body)) throw new Error("Borrador con frase plantilla (rechazado por control de calidad).");
    ({ channel, body, subject } = retry);
  }
  // Ancla de identidad (issue #9): marca, empresa, categoría/tópico y, en
  // última opción, ubicación. La fecha ISO puede aparecer pero NO valida
  // (antes imponía el telegrama por código con reintento/descarte). Se
  // conserva la prueba anti-alucinación sin recitar fecha+lugar.
  const identityTokens = [
    companyName,
    ...marcas.slice(0, 2),
    ...categorias.slice(0, 2),
    ...[...counts.keys()].slice(0, 3),
  ];
  const anchorTokens =
    identityTokens.some((t) => !!t && t.length >= 3)
      ? identityTokens
      : [lastF];
  if (!hasAnchor(body, anchorTokens)) {
    const retry = await attempt("tu borrador no nombra de forma reconocible al cliente o su negocio (marca, empresa o línea): reescribe integrándolo de forma natural en una frase.");
    if (!hasAnchor(retry.body, anchorTokens)) throw new Error("Borrador sin ancla (rechazado por control de calidad).");
    ({ channel, body, subject } = retry);
  }
  if (channel === "whatsapp" && body.length > 450) throw new Error("WhatsApp demasiado largo (>450).");
  if (body.length > 1300) throw new Error("Body demasiado largo (>1300).");

  const { error: insErr } = await db.from("proposed_actions").insert({
    store_id: storeId,
    customer_id: s.customer_id,
    country: s.country,
    signal_id: s.id,
    channel,
          subject: channel === "email" ? subject : null,
          body: body.slice(0, 2000),
          status: "pending_review",
          evidence_json: {
            generator: COPYWRITER_GEN,
            run_id: stamp.runId,
            catalog: stamp.catalog,
            at: new Date().toISOString(),
            // Puerta del juez (issue #9): veredicto auditado junto al borrador.
            contactability: {
              eligible: true,
              reason: verdict.reason,
              fail_open: verdict.failOpen,
              generator: JUDGE_GEN,
            },
            // Para estratificar el holdout futuro (issue #5, Paso 7).
            decision: s.decision ?? null,
            p_recompra_h: s.pRecompraH ?? null,
            // Auditoría humana: por qué esta propuesta (visible en Review/logs).
            kind: s.kind ?? null,
            reason: s.reason ?? null,
          },
        });
  if (insErr) throw new Error(`Action insert: ${insErr.message}`);
  const { error: sigErr } = await db
    .from("churn_signals")
    .update({ status: "actioned" })
    .eq("id", s.id);
  if (sigErr) throw new Error(`Signal update: ${sigErr.message}`);
  return { channel, chars: body.length };
}

/**
 * Redacta un borrador para UNA señal (desde "Tus 5 de hoy"). Sin duplicar:
 * si ya tiene borrador pendiente/aprobado, error honesto.
 */
export async function draftSingleSignal(
  storeId: string,
  signalId: string,
): Promise<{ ok: boolean; message: string }> {
  const mira = await getRankedMira(storeId);
  const found = [...mira.rows, ...mira.foreign].find((r) => r.signalId === signalId);
  if (!found || (found.status !== "open" && found.status !== "prioritized")) {
    return { ok: false, message: "Señal no disponible (ya resuelta o inexistente)." };
  }
  const db = getSupabase();
  const { data: busy } = await db
    .from("proposed_actions")
    .select("id,signal_id,customer_id")
    .eq("signal_id", signalId)
    .in("status", ["pending_review", "approved"])
    .limit(1);
  if ((busy ?? []).length > 0) {
    return { ok: false, message: "Ya tiene un borrador en Review." };
  }
  // Uno por cliente aunque sea otra señal: dos señales vivas del mismo
  // cliente con dos clics generaban dos borradores al mismo WhatsApp.
  const { data: busyCust } = await db
    .from("proposed_actions")
    .select("id")
    .eq("customer_id", found.customerDbId)
    .in("status", ["pending_review", "approved"])
    .limit(1);
  if ((busyCust ?? []).length > 0) {
    return { ok: false, message: "Este cliente ya tiene un borrador en Review (otra señal)." };
  }
  try {
    const { system, catalog } = await buildSystem(storeId);
    const { channel } = await draftForSignal(db, storeId, system, {
      id: found.signalId,
      kind: found.kind,
      objective: found.objective ?? null,
      score: found.score,
      reason: found.reason,
      customer_id: found.customerDbId,
      email: found.email,
      first_name: found.firstName,
      last_name: found.lastName,
      phone: found.phone,
      companyName: found.companyName ?? null,
      country: found.country,
      decision: found.decision ?? null,
      pRecompraH: found.pRecompraH ?? null,
    }, { runId: null, catalog });
    return { ok: true, message: `Borrador (${channel}) listo en Review.` };
  } catch (e) {
    if (e instanceof ContactabilitySkip) {
      return { ok: false, message: `${JUDGE_VETO_PREFIX}: ${e.message}` };
    }
    return { ok: false, message: e instanceof Error ? e.message : "No se pudo redactar." };
  }
}

export async function runCopywriter(
  runId: string,
  storeId: string,
  opts: CopywriterOpts = {},
): Promise<void> {
  const { limit = 10 } = opts;
  const db = getSupabase();
  let drafted = 0;
  let failed = 0;
  const step = (current: string | null) =>
    advanceRun(runId, { processed: drafted, failed, current });
  try {
    // Mismo ranking que Overview/Review (lib/mira): se redacta para el top
    // real, no para empates arbitrarios de score. La foránea va después.
    const mira = await getRankedMira(storeId);
    const rows = [...mira.rows, ...mira.foreign]
      .filter((r) => r.status === "prioritized")
      .slice(0, Math.max(limit * 3, 30))
      .map((r) => ({
        id: r.signalId,
        kind: r.kind,
        objective: r.objective ?? null,
        score: r.score,
        reason: r.reason,
        customer_id: r.customerDbId,
        email: r.email,
        first_name: r.firstName,
        last_name: r.lastName,
        phone: r.phone,
        companyName: r.companyName ?? null,
        country: r.country,
        decision: r.decision ?? null,
        pRecompraH: r.pRecompraH ?? null,
      }) satisfies Prioritized);
    log(`run ${runId} start priorizadas=${rows.length} limite=${limit}`);
    // Trazabilidad del ranking: si el top se discute, el log dice quién era.
    log(`run ${runId} top10=${rows.slice(0, 10).map((r) => r.email || r.customer_id).join(",")}`);

    // Sin borrador pendiente/aprobado para el mismo cliente (no duplicar).
    // Paginado completo: .limit(500) truncado generaba doble borrador.
    const busySignal = new Set<string>();
    const busyCustomer = new Set<string>();
    for (let off = 0; ; off += 1000) {
      const { data: epage, error: eErr } = await db
        .from("proposed_actions")
        .select("signal_id,customer_id")
        .eq("store_id", storeId)
        .in("status", ["pending_review", "approved"])
        .range(off, off + 999);
      if (eErr) throw new Error(`Existing read: ${eErr.message}`);
      const erows = (epage ?? []) as Array<Record<string, unknown>>;
      for (const a of erows) {
        const sid = String(a.signal_id ?? "");
        const cid = String(a.customer_id ?? "");
        if (sid) busySignal.add(sid);
        if (cid) busyCustomer.add(cid);
      }
      if (erows.length < 1000) break;
      if (busySignal.size + busyCustomer.size >= 20000) break;
    }
    const fresh = rows.filter((r) => !busySignal.has(r.id) && !busyCustomer.has(r.customer_id));
    log(`run ${runId} candidatas=${fresh.length} (con borrador: ${rows.length - fresh.length})`);

    // Lenguaje de compra del tenant (1 query por corrida, no por borrador):
    // sin esto el redactor trata todo como bodega (“llevaste un Rp Cajamarca”).
    const { system, catalog } = await buildSystem(storeId);

    // La puerta del juez puede omitir: se recorre el ranking hasta llenar el
    // límite (orden determinista + sensatez LLM). Omitidos ≠ fallidos.
    // Uno por cliente por corrida aunque queden dos señales vivas del mismo.
    let skipped = 0;
    const draftedCustomer = new Set<string>();
    for (const s of fresh) {
      if (drafted >= Math.max(0, limit)) break;
      if (draftedCustomer.has(s.customer_id)) continue;
      await step(null);
      try {
        const { channel, chars } = await draftForSignal(db, storeId, system, s, { runId, catalog });
        drafted += 1;
        draftedCustomer.add(s.customer_id);
        log(`run ${runId} ${s.email} → ${channel} (${chars} chars)`);
      } catch (e) {
        if (e instanceof ContactabilitySkip) {
          skipped += 1;
          log(`run ${runId} ${s.email || s.customer_id} omitido (juez): ${e.message}`);
        } else {
          failed += 1;
          log(`run ${runId} ${s.email || s.customer_id} ERROR ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    if (skipped > 0) {
      const seen = drafted + failed + skipped;
      log(`run ${runId} omitidos_juez=${skipped}/${seen} tasa=${Math.round((skipped / Math.max(1, seen)) * 100)}%`);
    }

    await step(null);
    const status: RunStatus = drafted === 0 && failed > 0 ? "error" : "done";
    // Filosofía TeamPulse: outcome + ahorro de tiempo. Los fallidos van en su
    // columna, no en el texto.
    const summary =
      drafted > 0
        ? `${drafted} ${drafted === 1 ? "listo" : "listos"} para tu visto bueno · te ahorran ~${drafted * 15} min`
        : "Sin borradores, no había a quién escribir · no invento mensajes";
    await finishRun(runId, {
      status,
      processed: drafted,
      failed,
      summary,
      pulseState: drafted > 0 ? "needs" : "paused",
    });
    log(`run ${runId} ${status} ${summary}`);
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed: drafted,
      failed,
      error: e instanceof Error ? e.message : String(e),
    });
    log(`run ${runId} ERROR ${e instanceof Error ? e.message : e}`);
  }
}
