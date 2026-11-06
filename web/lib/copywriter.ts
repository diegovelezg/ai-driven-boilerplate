// Copywriter (Proponer, Fase A): por señal `prioritized` redacta
// WhatsApp/email con historial real → `proposed_actions` `pending_review`.
// Nunca envía: el humano aprueba en /review y el dispatcher ejecuta.
// LLM vía proceso `proposer_draft` (primario → fallback). Corre en
// background con `background_runs` kind `copywriter`.
import { getSupabase } from "@/lib/supabase";
import { getRankedMira } from "@/lib/mira";
import { JUDGE_GEN, judgeContactability, type JudgeItem } from "@/lib/contactability";
import { JUDGE_VETO_PREFIX } from "@/lib/single-audit";
import { advanceRun, finishRun, type RunStatus, formatRunError } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { getStoreProfile, type CatalogType } from "@/lib/store-profiles";
import { getLlmConfig } from "@/lib/ai/llm-config";
import { completeJson } from "@/lib/retrieval";
import { formatMoney, formatNumber } from "@/lib/format";
import { briefMode, identityJugada, identityPatron } from "@/lib/judge-brief";

const log = createLogger("copywriter");

/** Versión del criterio generador. Sube cuando cambia el prompt/reglas:
 *  el regenerador solo rehace pendientes con sello viejo. */
import { COPYWRITER_GEN, isFreshGenerator, selectStaleRefresh, type StaleDraftRow } from "./copywriter-gen";

export { COPYWRITER_GEN };
export { selectStaleRefresh, type StaleDraftRow };

/** Sustantivo neutro para el brief según catálogo (el LLM repite esta palabra).
 *  Sin esto, todo tenant suena a vía pública ("pauta", "circuito", "zona"). */
function briefNoun(catalog: CatalogType | null): {
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
function purchaseLanguage(
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
- El cuerpo lleva SUSTANCIA concreta según el modo (viene en el brief). En continuidad: línea/marca/soporte del brief + ángulo útil + ventana fechada. En identidad (verás IDENTIDAD en el brief): 1 frase de reconocimiento + capacidad general con 1 ejemplo, sin fecha inventada; si no hay motivo fechado, no pongas fecha. PROHIBIDO el comodín vago solo («una idea», «una propuesta», «algo», «opciones») sin decir para qué línea/soporte. PROHIBIDO reciclar el evento de fecha única cambiando el ángulo.
- El historial dice quién es, no qué necesita hoy: úsalo solo para reconocer en una frase quién es. La propuesta nace de lo que el negocio sabe hacer por alguien como él, hoy. Si lo comprado solo tenía sentido en su ventana, esa ventana ya es recuerdo, no propuesta. Ve directo a lo nuevo; nunca hables del mensaje, de lo que no vas a proponer ni de tu razonamiento.
- PROHIBIDAS las frases de plantilla y call center (hay control automático: si las usas el borrador se rechaza).
- PROHIBIDA la pregunta abierta vaga y el ruego. Cierra con UNA invitación a accionar de máximo 15 palabras, siempre como pregunta reversible (¿te paso...? ¿te sirve...? ¿quieres que...?). PROHIBIDO declarar acciones cumplidas o comprometer inventario/disponibilidad como hecho: nunca bloqueo, reservo, aparto, separo, aseguro, avanzo o doy prioridad.
- Nunca menciones score, media, ciclo, arquetipo ni cifras internas: solo lo que el cliente reconocería.
- Tono por objetivo (viene en el brief): vip_care = leal, trato 1-a-1. nurture = hábito cortado, una lectura útil. winback = simple, baja fricción.
- Empieza con "Hola {primer nombre}," (solo primer nombre, nunca apellido ni email).
- Voz: primera persona singular + tuteo. PROHIBIDO "reservamos/preparamos" o el trato de usted.
- whatsapp: 1 sola idea, 250-400 caracteres, sin asunto (subject null). email: subject corto + cuerpo de 450-750 caracteres con estructura saludo + desarrollo (2 ideas: qué retomar y por qué ahora) + cierre.
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
  "bloqueo prioridad",
  "bloqueo",
  "avanzo con",
  "te reservo",
  "te aparto",
  "queda reservado",
  "queda bloqueado",
  "una idea para tu",
  "una propuesta para tu",
  "¿te la paso?",
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
class ContactabilitySkip extends Error {}

/** Re-export neutro para consumidores del modo brief (#23). */
export { briefMode, identityJugada, identityPatron } from "@/lib/judge-brief";

/** Baja del destinatario (issue #13): mismo trato que el veto del juez
 *  (omisión auditada, no fallo), pero por opt-out en vez de pertinencia. */
class OptOutSkip extends Error {}

/** Otro borrador vivo apareció entre el chequeo y el insert (rescate manual,
 *  corrida concurrente): omitir sin fallar. Sin esto, dos pendientes del
 *  mismo cliente o la misma señal conviven y Review los muestra duplicados. */
class DuplicateSkip extends Error {}

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

async function draft(system: string, user: string, meter?: { storeId: string }): Promise<string> {
  const cfg = getLlmConfig("proposer_draft");
  try {
    return await completeJson(cfg.primary, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user, meter ? { storeId: meter.storeId, process: "proposer_draft" } : undefined);
  } catch (e) {
    if (!cfg.fallback) throw e;
    log(`primario ${cfg.primary.model} falló (${e instanceof Error ? e.message : e}); fallback a ${cfg.fallback.model}`);
    return await completeJson(cfg.fallback, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user, meter ? { storeId: meter.storeId, process: "proposer_draft", usedFallback: true } : { usedFallback: true });
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
  /** Contrato final (#25): opcionales para ranking/activos sin romper callers. */
  valorEsperadoMinor?: number | null;
  isActive?: boolean | null;
  detalles?: Record<string, string | number> | null;
}

type Db = ReturnType<typeof getSupabase>;

/** System prompt con el lenguaje de compra + activos del tenant (2 queries, reutilizable).
 *  Hito 1 (#25): top-3 activos de product_stats + vertical + ventana/ticket del brain.
 *  El writer propone solo activos (cero inactivos) con fecha concreta. */
async function buildSystem(storeId: string): Promise<{
  system: string;
  catalog: CatalogType | null;
  brain: import("@/lib/brain").TenantBrain | null;
  inactiveNorm: Set<string>;
  inactiveLoose: Set<string>;
}> {
  const [brainNs, profile] = await Promise.all([
    import("@/lib/brain").catch(() => null),
    getStoreProfile(storeId).catch(() => null),
  ]);
  let brain: import("@/lib/brain").TenantBrain | null = null;
  try {
    brain = brainNs ? await brainNs.getTenantBrain(storeId).catch(() => null) : null;
  } catch {
    brain = null;
  }
  const langLine = purchaseLanguage(profile?.catalogType ?? null, profile?.verticalDetected ?? null);
  const vertical = (profile?.verticalDetected ?? "").trim().slice(0, 120) || null;
  const topActivos = (brain?.topProductos ?? []).slice(0, 3).map((p) => p.title).filter(Boolean);
  let inactiveNorm = new Set<string>();
  let inactiveLoose = new Set<string>();
  try {
    const { normProductTitle, normProductTitleLoose } = await import("@/lib/product-stats");
    const { data } = await getSupabase()
      .from("products")
      .select("title")
      .eq("store_id", storeId)
      .eq("is_active", false)
      .limit(1000);
    for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
      const t = normProductTitle(String(r.title ?? ""));
      if (t) inactiveNorm.add(t);
      const tl = normProductTitleLoose(String(r.title ?? ""));
      if (tl) inactiveLoose.add(tl);
    }
  } catch {
    inactiveNorm = new Set<string>();
    inactiveLoose = new Set<string>();
  }
  const brainLine = brain
    ? `Activos que sí se pueden proponer (top ventas activas): ${topActivos.length > 0 ? topActivos.join(" · ") : "sin top"}.`
      + `${vertical ? ` Capacidad general: ${vertical}.` : ""}`
      + `${brain.ventanaMedianaDias != null ? ` Ventana típica: ~${brain.ventanaMedianaDias}d.` : ""}`
      + `${brain.ticketP50 != null ? ` Ticket típico: ${formatMoney(brain.ticketP50, brain.ticketCurrency)}.` : ""}`
      + ` PROHIBIDO proponer inactivos/descatalogados (no están en la lista) o inventar disponibilidad.`
    : `${vertical ? `Capacidad general: ${vertical}. ` : ""}PROHIBIDO proponer inactivos/descatalogados o inventar disponibilidad.`;
  return {
    system: `${SYSTEM}\nLenguaje del negocio: ${langLine}\n${brainLine}`,
    catalog: profile?.catalogType ?? null,
    brain,
    inactiveNorm,
    inactiveLoose,
  };
}

/** Compone el copy de UN borrador (historial real → juez → LLM → controles).
 *  No escribe: `draftForSignal` persiste (insert + actioned) y
 *  `previewSignalCopy` lo devuelve para re-redactar in place. Lanza si falla. */
async function composeDraftCopy(
  db: Db,
  storeId: string,
  system: string,
  s: Prioritized,
  stamp: {
    runId: string | null;
    catalog: CatalogType | null;
    forceChannel?: "email" | "whatsapp" | null;
    brain?: import("@/lib/brain").TenantBrain | null;
    inactiveNorm?: Set<string>;
    inactiveLoose?: Set<string>;
  },
): Promise<{
  channel: string;
  body: string;
  subject: string | null;
  verdict: { reason: string; failOpen: boolean; reusable: boolean };
}> {
  const { data: orders } = await db
    .from("orders")
    .select("total_amount,currency,placed_at,items_json,status,payment_status,is_test")
    .eq("customer_id", s.customer_id)
    .order("placed_at", { ascending: false })
    .limit(10);
  const { isRealDbOrder } = await import("@/lib/canonical");
  const real = (((orders ?? []) as Array<Record<string, unknown>>).filter((o) =>
    isRealDbOrder({
      status: typeof o.status === "string" ? o.status : null,
      payment_status: typeof o.payment_status === "string" ? o.payment_status : null,
      is_test: o.is_test === true,
    }),
  )).slice(0, 5);
  // Historial legible: fecha corta + contenido de la key elegida en settings
  // (contiene/categoría). Nada de otras keys: sin contenido, solo títulos.
  const { enrichOrderItems } = await import("@/lib/item-context");
  const { resolveItemKeys } = await import("@/lib/metadata-map");
  const rawPerOrder = real.map((o) =>
    ((o.items_json as Array<Record<string, unknown>>) ?? []).map((i) => ({
      title: String(i.title ?? "").trim(),
      quantity: Number(i.quantity ?? 0),
      metadata: (i.metadata as Record<string, unknown> | undefined) ?? undefined,
    })),
  );
  const itemKeys = await resolveItemKeys(storeId).catch(() => null);
  const enrichedAll = await enrichOrderItems(storeId, rawPerOrder.flat(), itemKeys ?? undefined);
  // Filtro de activos (#25.1): cero borradores de inactivos. Agnóstico: compara
  // por título normalizado (exacto + loose) contra products.is_active=false.
  const { normProductTitle: normTitle, normProductTitleLoose: normTitleLoose } = await import("@/lib/product-stats");
  const inactive = stamp.inactiveNorm ?? new Set<string>();
  const inactiveL = stamp.inactiveLoose ?? new Set<string>();
  const isInactiveTitle = (t: string) => {
    const n = normTitle(t);
    if (n && inactive.has(n)) return true;
    const nl = n ? normTitleLoose(t) : "";
    return !!nl && inactiveL.has(nl);
  };
  // Reconstruye por pedido ANTES de filtrar: enrichedAll va en orden plano
  // rawPerOrder.flat(). Si se filtra y luego se hace slice por longitudes
  // crudas, los ítems se atribuyen a fecha/orden equivocada (P1).
  const perOrderEnriched: Array<Array<(typeof enrichedAll)[number]>> = [];
  {
    let c0 = 0;
    for (const arr of rawPerOrder) {
      perOrderEnriched.push(enrichedAll.slice(c0, c0 + arr.length));
      c0 += arr.length;
    }
  }
  const enrichedFlat = perOrderEnriched.flat().filter((it) => !isInactiveTitle(it.title));
  // Si todo era inactivo, se conserva uno para reconocer (modo identidad) pero
  // el patrón/jugada nunca propone inactivos (brain.topProductos manda).
  const perOrderForHist = perOrderEnriched.map((arr) => {
    const f = arr.filter((it) => !isInactiveTitle(it.title));
    return f.length > 0 ? f : arr.slice(0, 1);
  });
  const noun = briefNoun(stamp.catalog);
  // Ticket del cliente (respaldo concreto, no comodín). Minor units, misma
  // moneda: sin filtrar se mezclaría PEN+MXN en un promedio mal rotulado.
  const ticketCurVotes = new Map<string, number>();
  for (const o of real) {
    const c = String(o.currency ?? "").trim().toUpperCase();
    if (c) ticketCurVotes.set(c, (ticketCurVotes.get(c) ?? 0) + 1);
  }
  const ticketCur = [...ticketCurVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const ticketVals = real
    .filter((o) => !ticketCur || String(o.currency ?? "").toUpperCase() === ticketCur)
    .map((o) => Number(o.total_amount ?? 0))
    .filter((n) => n > 0);
  const ticketClienteMinor = ticketVals.length > 0 ? Math.round(ticketVals.reduce((a, b) => a + b, 0) / ticketVals.length) : null;
  const ticketClienteTxt = ticketClienteMinor != null ? formatMoney(ticketClienteMinor, ticketCur ?? stamp.brain?.ticketCurrency ?? null) : null;
  const histLines = real.map((o, oi) => {
    const iso = String(o.placed_at ?? "?").slice(0, 10);
    const f = fechaCorta(String(o.placed_at ?? "")) ?? iso;
    const items = perOrderForHist[oi] ?? [];
    const titles = items.map((i) => i.title).filter((t) => t && t !== "—").slice(0, 4).join(" · ");
    const extras: string[] = [];
    for (const it of items.slice(0, 2)) {
      if (it.contiene) extras.push(`contiene "${it.contiene}"${it.categoria ? ` [${it.categoria}]` : ""}`);
    }
    return `- ${f} (${iso}): ${titles || noun.empty}${extras.length > 0 ? ` — ${extras.join("; ")}` : ""}`;
  });
  const hist = histLines.join("\n") || "(sin compras visibles)";
  // Patrón del cliente: ¿repite circuito o explora? Solo activos (inactivos fuera).
  const counts = new Map<string, number>();
  for (const o of real) {
    for (const i of ((o.items_json as Array<Record<string, unknown>>) ?? [])) {
      const t = String(i.title ?? "").trim();
      if (!t || t === "—" || isInactiveTitle(t)) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
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

  // Dossier-first (issue #9): quién es + por-qué-ahora abren; fecha/lugares
  // van a datos de respaldo ("úsalos solo si encajan natural"). company_name
  // hoy ni se leía en el brief: se trae del Prioritized o de customers.
  // Sube antes del juez (#23): el veredicto reusable lo necesita.
  let companyName = (s.companyName ?? "").trim() || null;
  let ordersCount: number | null = null;
  {
    const { data: cRow } = await db
      .from("customers")
      .select("company_name,orders_count")
      .eq("id", s.customer_id)
      .maybeSingle();
    const cn = (cRow as Record<string, unknown> | null)?.company_name;
    if (!companyName && typeof cn === "string" && cn.trim()) companyName = cn.trim().slice(0, 120);
    const oc = (cRow as Record<string, unknown> | null)?.orders_count;
    ordersCount = typeof oc === "number" && Number.isFinite(oc) ? oc : null;
  }
  const marcas: string[] = [];
  const categorias: string[] = [];
  for (const it of enrichedFlat) {
    const m = it.contiene?.split(":")[0]?.trim() ?? "";
    if (m && m.length >= 3 && !marcas.includes(m)) marcas.push(m);
    if (it.categoria && !categorias.includes(it.categoria)) categorias.push(it.categoria);
  }
  const quien = companyName ?? marcas[0] ?? categorias[0] ?? null;

  // Puerta de contactabilidad (#9, #23, #25.6): el juez razona una vez sobre
  // el contenido + hoy y devuelve reusable. Sin ventanas de metadata (no
  // fluyen): la ventana típica del negocio la pone el brain.
  const judgeItems: JudgeItem[] = enrichedFlat.map((en) => ({
    title: en.title,
    contiene: en.contiene,
    categoria: en.categoria,
  }));
  const todayIso = new Date().toISOString().slice(0, 10);
  const verdict = await judgeContactability({
    firstName,
    companyName,
    objetivo,
    daysSince: days,
    todayIso,
    comprasPrevias: ordersCount,
    items: judgeItems,
    catalog: stamp.catalog ?? null,
    ventanaTipicaDias: stamp.brain?.ventanaMedianaDias ?? null,
  }, { storeId });
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

  // Brief condicional (#23): si reusable=false, el pasado solo reconoce.
  // Nunca ordenar continuidad en modo identidad: esa era la raíz del caso
  // Patricia (CONTENIDO + jugada habitual vs PROHIBIDO del SYSTEM).
  // Hito 1 (#25.1): ventana concreta + ticket dirigen la jugada.
  // SSOT compras (órdenes locales, no metadata): ritmo propio del cliente =
  // mediana de gaps entre sus compras reales; fallback típica del negocio.
  const gaps: number[] = [];
  for (let i = 0; i + 1 < real.length; i++) {
    const a = Date.parse(String(real[i]?.placed_at ?? ""));
    const b = Date.parse(String(real[i + 1]?.placed_at ?? ""));
    if (Number.isFinite(a) && Number.isFinite(b) && a >= b) gaps.push(Math.round((a - b) / 86_400_000));
  }
  gaps.sort((x, y) => x - y);
  const gapMed = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : null;
  const durFromLast = gapMed ?? stamp.brain?.ventanaMedianaDias ?? 4;
  const sugStart = new Date(`${todayIso}T12:00:00`);
  sugStart.setDate(sugStart.getDate() + 6);
  const sugEnd = new Date(sugStart);
  sugEnd.setDate(sugEnd.getDate() + Math.max(0, durFromLast));
  const sugStartIso = sugStart.toISOString().slice(0, 10);
  const sugEndIso = sugEnd.toISOString().slice(0, 10);
  const ritmoTxt = gapMed != null ? `cada ~${formatNumber(gapMed)}d como tus compras` : stamp.brain?.ventanaMedianaDias != null ? `típica del negocio ~${formatNumber(stamp.brain.ventanaMedianaDias)}d` : null;
  const sugLine = `Ventana sugerida${ritmoTxt ? ` (${ritmoTxt})` : ""}: ${fechaCorta(sugStartIso) ?? sugStartIso} → ${fechaCorta(sugEndIso) ?? sugEndIso} (${sugStartIso}→${sugEndIso}). Última compra ${lastF ?? "sin fecha"}${ticketClienteTxt != null ? ` · ticket típico suyo ~${ticketClienteTxt}` : ""}.`;
  const mode = briefMode(verdict.reusable);
  const basePatron =
    topCat && topCat[1] >= 2
      ? `CONTENIDO: ${noun.repeat} "${topCat[0]}"${marcaByCat.get(topCat[0]) ? ` (ej. ${marcaByCat.get(topCat[0])})` : ""}. Tono: continuidad de su línea`
      : top && top[1] >= 2
        ? `REPITE: suele volver a "${top[0]}". Tono: volver a lo que le funciona`
        : distinct >= 3
          ? `EXPLORA: prueba opciones distintas. Tono: novedad`
          : top
            ? `última elección "${top[0]}"`
            : "sin patrón legible";
  const baseJugada =
    stamp.catalog === "servicio" || stamp.catalog === "digital"
      ? basePatron.startsWith("CONTENIDO") || basePatron.startsWith("REPITE")
        ? "pasarle 2-3 opciones concretas de disponibilidad o un ángulo para su línea habitual en esta temporada, y preguntarle si quiere que se las pase con fechas"
        : basePatron.startsWith("EXPLORA")
          ? "mostrarle una opción concreta que aún no prueba, o cotizarle su mejor ubicación para la temporada, y preguntarle si quiere que se la pase con fechas"
          : "pasarle una propuesta concreta y simple para retomar (línea + ventana de fechas), y preguntarle si le sirve"
      : basePatron.startsWith("CONTENIDO") || basePatron.startsWith("REPITE")
        ? "pasarle su favorito habitual o una opción distinta y concreta de su línea para esta temporada, y preguntarle si quiere que se la pase"
        : basePatron.startsWith("EXPLORA")
          ? "mostrarle algo nuevo y concreto de su línea, o pasarle su favorito con ventana concreta para que lo mire sin compromiso"
          : "pasarle una propuesta concreta y simple para retomar (producto + momento), y preguntarle si le sirve";
  const patron = mode === "identidad" ? identityPatron(quien) : basePatron;
  const jugada = mode === "identidad" ? identityJugada() : `${baseJugada}. ${sugLine}`;
  // En identidad no se inyecta ventana sugerida: obligaba a inventar motivo
  // para una fecha (caso Jin). La fecha solo dirige en continuidad.
  const respaldoVentana = mode === "identidad" ? "" : ` ${sugLine}`;
  const dossier = quien
    ? `Cliente: ${firstName} — ${quien}${companyName && marcas[0] && marcas[0] !== companyName ? ` (en sus piezas: ${marcas[0]}${categorias[0] ? ` · ${categorias[0]}` : ""})` : categorias[0] && categorias[0] !== quien ? ` (${categorias[0]})` : ""} (objetivo ${objetivo})`
    : `Cliente: ${firstName} (objetivo ${objetivo})`;

  const user = [
    dossier,
    `Por-qué-ahora en una línea: ${estado}. ${patron}.`,
    `Jugada (elige UNA, no las combines): ${jugada}.`,
    `Datos de respaldo (úsalos solo si encajan natural en una frase sobre su negocio, nunca como lista ni telegrama): ${noun.last} ${lastF ?? "?"}${lastIso ? ` (${lastIso})` : ""}, hace ${days ?? "?"} días.${respaldoVentana}`,
    `Historial real (usa nombres tal cual, no inventes):`,
    hist,
    stamp.forceChannel === "whatsapp"
      ? "Canal obligatorio: whatsapp. Responde con \"channel\": \"whatsapp\"."
      : stamp.forceChannel === "email"
        ? "Canal obligatorio: email. Responde con \"channel\": \"email\"."
        : s.phone
          ? "Canal: whatsapp (tiene teléfono)."
          : "Canal: email (sin teléfono).",
  ].join("\n");

  const attempt = async (extraNudge: string | null): Promise<{ channel: string; body: string; subject: string | null }> => {
    const raw = await draft(system, extraNudge ? `${user}\n\nREINTENTO: ${extraNudge}` : user, { storeId });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const channel = parsed.channel === "email" ? "email" : "whatsapp";
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    const subject = typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim().slice(0, 200) : null;
    return { channel, body, subject };
  };

  let { channel, body, subject } = await attempt(null);
  // El canal explícito manda (email siempre seguro; whatsapp exige teléfono
  // y el control de ≤450 de abajo lo valida). Sin él, vale lo del LLM.
  if (stamp.forceChannel === "email") {
    channel = "email";
  } else if (stamp.forceChannel === "whatsapp" && s.phone) {
    channel = "whatsapp";
  }
  if (!body) throw new Error("El LLM devolvió body vacío.");
  if (hasBanned(body)) {
    const retry = await attempt("tu borrador anterior sonaba a plantilla genérica; reescribe con otra estructura y otras palabras, sin ninguna frase prohibida.");
    if (hasBanned(retry.body)) throw new Error("Borrador con frase plantilla (rechazado por control de calidad).");
    ({ channel, body, subject } = retry);
  }
  // Ancla de identidad (issue #9): marca, empresa, categoría/tópico y, en
  // última opción, ubicación. En identidad también vale el activo propuesto
  // (si no, el control obliga a repetir el evento puntual que identidad
  // quería soltar). La fecha ISO puede aparecer pero NO valida.
  const identityTokens = [
    companyName,
    ...marcas.slice(0, 2),
    ...categorias.slice(0, 2),
    ...[...counts.keys()].slice(0, 3),
  ];
  const identidadActivos = mode === "identidad"
    ? ((stamp.brain?.topProductos ?? []).slice(0, 3).map((p) => p.title).filter((t) => t && t.length >= 4))
    : [];
  const anchorTokens =
    identidadActivos.length > 0
      ? [...identityTokens, ...identidadActivos]
      : identityTokens.some((t) => !!t && t.length >= 3)
        ? identityTokens
        : [lastF];
  if (!hasAnchor(body, anchorTokens)) {
    const retry = await attempt("tu borrador no nombra de forma reconocible al cliente o su negocio (marca, empresa o línea): reescribe integrándolo de forma natural en una frase.");
    if (!hasAnchor(retry.body, anchorTokens)) throw new Error("Borrador sin ancla (rechazado por control de calidad).");
    ({ channel, body, subject } = retry);
  }
  if (channel === "whatsapp" && body.length > 450) throw new Error("WhatsApp demasiado largo (>450).");
  if (body.length > 800) throw new Error("Body demasiado largo (>800).");
  // Email corto no se distingue del WhatsApp: un reintento para desarrollar;
  // si persiste, se descarta (mismo patrón que plantilla/ancla).
  if (channel === "email" && body.length < 400) {
    const retry = await attempt("tu borrador de email quedó muy corto: desarrolla con saludo + 2 ideas (qué retomar y por qué ahora) + cierre, mínimo 450 caracteres.");
    if (retry.channel !== "email" || retry.body.length < 400) throw new Error("Email demasiado corto (<400).");
    ({ channel, body, subject } = retry);
  }

  return { channel, body, subject, verdict };
}

/** Re-chequeo justo antes de mutar: si entre el filtro inicial y el insert
 *  (LLM de ~30s en medio) apareció otro borrador vivo del mismo cliente o
 *  la misma señal (rescate manual, corrida concurrente), se omite en vez de
 *  duplicar. `excludeActionId` es el propio stale en refresh (se reemplaza). */
async function assertNoLiveDraft(
  db: Db,
  storeId: string,
  s: { signalId: string | null; customerId: string },
  excludeActionId?: string | null,
): Promise<void> {
  const orParts = [`customer_id.eq.${s.customerId}`];
  if (s.signalId) orParts.push(`signal_id.eq.${s.signalId}`);
  const { data, error } = await db
    .from("proposed_actions")
    .select("id")
    .eq("store_id", storeId)
    .in("status", ["pending_review", "approved"])
    .or(orParts.join(","))
    .limit(2);
  if (error) throw new Error(`Live draft recheck: ${error.message}`);
  const hit = ((data ?? []) as Array<Record<string, unknown>>).find(
    (r) => String(r.id ?? "") !== (excludeActionId ?? ""),
  );
  if (hit) {
    throw new DuplicateSkip("Ya tiene un borrador en Review (otra señal o rescate concurrente).");
  }
}

/** Persiste UN borrador (insert + señal a actioned). Usado por el bulk y el single. */
async function draftForSignal(
  db: Db,
  storeId: string,
  system: string,
  s: Prioritized,
  stamp: {
    runId: string | null;
    catalog: CatalogType | null;
    forceChannel?: "email" | "whatsapp" | null;
    brain?: import("@/lib/brain").TenantBrain | null;
    inactiveNorm?: Set<string>;
    inactiveLoose?: Set<string>;
  },
): Promise<{ channel: string; chars: number }> {
  // Issue #13: baja total (ambos canales) → ni se redacta. La baja parcial
  // se chequea tras conocer el canal (el otro canal sigue sirviendo).
  const { isFullyOptedOut, isOptedOut } = await import("@/lib/pre-send");
  if (await isFullyOptedOut(storeId, s.customer_id)) {
    throw new OptOutSkip("baja total del destinatario (opt-out email + whatsapp)");
  }
  const { channel, body, subject, verdict } = await composeDraftCopy(db, storeId, system, s, stamp);
  if (await isOptedOut(storeId, s.customer_id, channel)) {
    throw new OptOutSkip(`baja del destinatario en ${channel} (opt-out)`);
  }
  // Re-chequeo anti-duplicado justo antes del insert (el LLM tardó ~30s:
  // un rescate manual o una corrida concurrente pudo crear otro vivo).
  await assertNoLiveDraft(db, storeId, { signalId: s.id, customerId: s.customer_id });
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
              reusable: verdict.reusable,
              reason: verdict.reason,
              fail_open: verdict.failOpen,
              generator: JUDGE_GEN,
            },
            // Para estratificar el holdout futuro (issue #5, Paso 7).
            decision: s.decision ?? null,
            p_recompra_h: s.pRecompraH ?? null,
            // Auditoría humana: por qué esta propuesta (visible en Review/logs).
            // objective = tratamiento (winback/nurture/vip_care); kind = origen.
            kind: s.kind ?? null,
            objective: s.objective ?? null,
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
 * Compone el copy para UNA señal sin persistir (switch de canal en Review:
 * re-redacta la misma fila in place). Sin checks de duplicado: el llamador
 * es dueño de la fila. Error honesto si la señal no está disponible.
 */
export async function previewSignalCopy(
  storeId: string,
  signalId: string,
  forceChannel: "email" | "whatsapp",
): Promise<
  | { ok: true; channel: string; body: string; subject: string | null }
  | { ok: false; message: string }
> {
  const mira = await getRankedMira(storeId);
  const found = [...mira.rows, ...mira.foreign].find((r) => r.signalId === signalId);
  if (!found || (found.status !== "open" && found.status !== "prioritized")) {
    return { ok: false, message: "Señal no disponible (ya resuelta o inexistente)." };
  }
  try {
    const db = getSupabase();
    const { system, catalog, brain, inactiveNorm, inactiveLoose } = await buildSystem(storeId);
    const { channel, body, subject } = await composeDraftCopy(db, storeId, system, {
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
    }, { runId: null, catalog, forceChannel, brain, inactiveNorm, inactiveLoose });
    return { ok: true, channel, body, subject };
  } catch (e) {
    if (e instanceof OptOutSkip) {
      return { ok: false, message: `Baja del destinatario: ${e.message}.` };
    }
    if (e instanceof ContactabilitySkip) {
      return { ok: false, message: `${JUDGE_VETO_PREFIX}: ${e.message}` };
    }
    return { ok: false, message: e instanceof Error ? e.message : "No se pudo redactar." };
  }
}

/**
 * Redacta un borrador para UNA señal (desde "Tus 5 de hoy"). Sin duplicar:
 * si ya tiene borrador pendiente/aprobado, error honesto.
 */
export async function draftSingleSignal(
  storeId: string,
  signalId: string,
  opts: { forceChannel?: "email" | "whatsapp" | null } = {},
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
    const { system, catalog, brain, inactiveNorm, inactiveLoose } = await buildSystem(storeId);
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
    }, { runId: null, catalog, forceChannel: opts.forceChannel ?? null, brain, inactiveNorm, inactiveLoose });
    return { ok: true, message: `Borrador (${channel}) listo en Review.` };
  } catch (e) {
    if (e instanceof OptOutSkip) {
      return { ok: false, message: `Baja del destinatario: ${e.message}.` };
    }
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
        .order("id", { ascending: true })
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

    // Lenguaje + activos del tenant (2 queries por corrida, no por borrador):
    // sin esto el redactor trata todo como bodega (“llevaste un Rp Cajamarca”)
    // y puede proponer inactivos.
    const { system, catalog, brain, inactiveNorm, inactiveLoose } = await buildSystem(storeId);

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
        const { channel, chars } = await draftForSignal(db, storeId, system, s, { runId, catalog, brain, inactiveNorm, inactiveLoose });
        drafted += 1;
        draftedCustomer.add(s.customer_id);
        log(`run ${runId} ${s.email} → ${channel} (${chars} chars)`);
      } catch (e) {
        if (e instanceof OptOutSkip) {
          skipped += 1;
          log(`run ${runId} ${s.email || s.customer_id} omitido (opt-out): ${e.message}`);
        } else if (e instanceof ContactabilitySkip) {
          skipped += 1;
          log(`run ${runId} ${s.email || s.customer_id} omitido (juez): ${e.message}`);
        } else if (e instanceof DuplicateSkip) {
          skipped += 1;
          log(`run ${runId} ${s.email || s.customer_id} omitido (duplicado): ${e.message}`);
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
    // columna, no en el texto. El 0 se desambigua: no es lo mismo "nada
    // priorizado" que "ya tenían borrador" o "juez vetó". Sin esto el botón
    // "Redactar los N" parece roto cuando en realidad no duplicó.
    const alreadyHad = rows.length - fresh.length;
    const summary =
      drafted > 0
        ? `${formatNumber(drafted)} ${drafted === 1 ? "listo" : "listos"} para tu visto bueno · te ahorran ~${formatNumber(drafted * 15)} min`
        : alreadyHad > 0
          ? `Sin borradores nuevos, ${formatNumber(alreadyHad)} ya ${alreadyHad === 1 ? "tenía borrador" : "tenían borrador"} en Review · no duplico`
          : skipped > 0
            ? `Sin borradores, ${formatNumber(skipped)} ${skipped === 1 ? "omitido" : "omitidos"} por juez · no invento mensajes`
            : "Sin borradores, no había priorizados frescos · no invento mensajes";
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
      error: formatRunError(e),
    });
    log(`run ${runId} ERROR ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Auto-refresh transparente de stale (#26): re-redacta pendientes con sello
 * viejo sin tocar approved/dispatched y sin auto-envíos. Flujo por borrador:
 * compone con criterios actuales → borra el viejo POR ID solo si el nuevo
 * quedó OK → inserta el fresco + señal a `actioned` (solo señales vivas).
 * Huérfanos sin señal se purgan (no se pueden redactar ni enviar); señales
 * `closed`/`dismissed` se saltan (no se resucitan). Acotado a 10/corrida y
 * 1 `buildSystem` por corrida (sin N+1). Best-effort: el fallo deja el viejo
 * pendiente y el siguiente login reintenta.
 */
export async function runStaleRefresh(
  runId: string,
  storeId: string,
  opts: { limit?: number } = {},
): Promise<void> {
  const limit = Math.max(0, Math.min(opts.limit ?? 10, 10));
  const db = getSupabase();
  let drafted = 0;
  let failed = 0;
  let skipped = 0;
  let purged = 0;
  const step = (current: string | null) =>
    advanceRun(runId, { processed: drafted, failed, current });
  const doneSummary = (n: number) =>
    n > 0
      ? `${formatNumber(n)} ${n === 1 ? "borrador actualizado" : "borradores actualizados"} con criterios nuevos · ${n === 1 ? "sigue pendiente" : "siguen pendientes"} de tu visto bueno`
      : "Nada que actualizar: todo con criterios actuales";
  // Límite 0 = apagado real: ni purga ni redrafts, sin lecturas pesadas.
  if (limit === 0) {
    await finishRun(runId, { status: "done", processed: 0, failed: 0, summary: doneSummary(0), pulseState: "paused" });
    log(`run ${runId} omitido (limite=0)`);
    return;
  }
  try {
    // 1. Pendientes stale (paginado con range, escaneo acotado: basta para
    // llenar el límite sin leer el universo cada mañana).
    const stale: Array<{ id: string; signal_id: string | null; customer_id: string; generator: string | null; decision: string | null; pRecompraH: number | null }> = [];
    let scanned = 0;
    const PAGE = 500;
    const MAX_SCAN = 2000;
    for (let off = 0; off < MAX_SCAN; off += PAGE) {
      const { data, error } = await db
        .from("proposed_actions")
        .select("id,signal_id,customer_id,evidence_json")
        .eq("store_id", storeId)
        .eq("status", "pending_review")
        .order("id", { ascending: true })
        .range(off, off + PAGE - 1);
      if (error) throw new Error(`Stale read: ${error.message}`);
      const page = (data ?? []) as Array<Record<string, unknown>>;
      scanned += page.length;
      for (const r of page) {
        const ev = (r.evidence_json as Record<string, unknown> | null) ?? null;
        const gen = ev ? String((ev as Record<string, unknown>).generator ?? "") : "";
        if (isFreshGenerator(gen)) continue;
        // P2: el refresco debe conservar el segmento del motor (si no, cae
        // en `unknown` en Finanzas). Se hereda del borrador viejo y, si falta,
        // se rellena con la predicción vigente (paso 5b).
        const decRaw = ev ? (ev as Record<string, unknown>).decision : null;
        const pRaw = ev ? ((ev as Record<string, unknown>).p_recompra_h ?? (ev as Record<string, unknown>).pRecompraH) : null;
        stale.push({
          id: String(r.id ?? ""),
          signal_id: (r.signal_id as string | null) ?? null,
          customer_id: String(r.customer_id ?? ""),
          generator: gen || null,
          decision: typeof decRaw === "string" && decRaw ? decRaw : null,
          pRecompraH: typeof pRaw === "number" && Number.isFinite(pRaw) ? pRaw : null,
        });
        if (stale.length >= Math.max(limit * 3, 30)) break;
      }
      if (page.length < PAGE) break;
      if (stale.length >= Math.max(limit * 3, 30)) break;
    }
    log(`run ${runId} stale pendientes=${stale.length} (escaneados=${scanned} limite=${limit})`);
    if (stale.length === 0) {
      await finishRun(runId, { status: "done", processed: 0, failed: 0, summary: doneSummary(0), pulseState: "paused" });
      return;
    }
    const staleIds = new Set(stale.map((s) => s.id));

    // 2. Estado de sus señales (misma guarda que el bulk: sin comprobar no se toca).
    const sids = [...new Set(stale.map((s) => s.signal_id).filter((x): x is string => !!x))];
    const sigById = new Map<string, { status: string; kind: string; objective: string | null; score: number | null; reason: string | null; customer_id: string }>();
    for (let i = 0; i < sids.length; i += 200) {
      const { data, error } = await db
        .from("churn_signals")
        .select("id,status,kind,objective,score,reason,customer_id")
        .in("id", sids.slice(i, i + 200));
      if (error) throw new Error(`Signals read: ${error.message}`);
      for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
        sigById.set(String(r.id ?? ""), {
          status: String(r.status ?? ""),
          kind: String(r.kind ?? ""),
          objective: (r.objective as string | null) ?? null,
          score: typeof r.score === "number" ? r.score : null,
          reason: (r.reason as string | null) ?? null,
          customer_id: String(r.customer_id ?? ""),
        });
      }
    }

    // 3. Huérfanos sin señal: se purgan (no se pueden redactar ni enviar,
    // igual que el botón manual). Solo pending_review + stale + sin fila.
    // P3: acotado por el mismo límite (barato pero mutación al fin): con
    // más huérfanos que el límite, el resto queda para la próxima mañana.
    const orphansAll = stale.filter((s) => !s.signal_id || !sigById.has(s.signal_id));
    const orphans = orphansAll.slice(0, limit);
    if (orphansAll.length > orphans.length) {
      log(`run ${runId} huerfanos diferidos=${orphansAll.length - orphans.length} (limite=${limit})`);
    }
    for (let i = 0; i < orphans.length; i += 200) {
      const chunk = orphans.slice(i, i + 200).map((s) => s.id);
      const { error } = await db
        .from("proposed_actions")
        .delete()
        .in("id", chunk)
        .eq("status", "pending_review");
      if (error) throw new Error(`Orphan purge: ${error.message}`);
      purged += chunk.length;
      await step(null).catch(() => {});
    }
    if (orphans.length > 0) log(`run ${runId} huerfanos purgados=${orphans.length}`);
    const withSignal = stale.filter((s) => s.signal_id && sigById.has(s.signal_id));

    // 4. Busy fresco (excluye a los propios stale: si no, todo se auto-bloquea).
    // Paginado completo como runCopywriter (el .limit(500) truncado duplicaba).
    const busySignal = new Set<string>();
    const busyCustomer = new Set<string>();
    for (let off = 0; ; off += 1000) {
      const { data: epage, error: eErr } = await db
        .from("proposed_actions")
        .select("id,signal_id,customer_id")
        .eq("store_id", storeId)
        .in("status", ["pending_review", "approved"])
        .order("id", { ascending: true })
        .range(off, off + 999);
      if (eErr) throw new Error(`Existing read: ${eErr.message}`);
      const erows = (epage ?? []) as Array<Record<string, unknown>>;
      for (const a of erows) {
        const aid = String(a.id ?? "");
        if (staleIds.has(aid)) continue;
        const sid = String(a.signal_id ?? "");
        const cid = String(a.customer_id ?? "");
        if (sid) busySignal.add(sid);
        if (cid) busyCustomer.add(cid);
      }
      if (erows.length < 1000) break;
      if (busySignal.size + busyCustomer.size >= 20000) break;
    }

    // 5. Selección pura (stale-solo-pending, vivas, límite, 1-por-cliente).
    const rows: StaleDraftRow[] = withSignal.map((s) => ({
      id: s.id,
      signalId: s.signal_id,
      customerId: s.customer_id,
      status: "pending_review",
      generator: s.generator,
    }));
    const statusById: Record<string, string> = {};
    for (const [k, v] of sigById) statusById[k] = v.status;
    const picked = selectStaleRefresh(rows, statusById, { limit, busySignal, busyCustomer });
    const closedSkipped = withSignal.length - picked.length - withSignal.filter((s) => busySignal.has(s.signal_id!) || busyCustomer.has(s.customer_id)).length;
    log(`run ${runId} elegidos=${picked.length} (vivas=${withSignal.length} busy/omitidos=${withSignal.length - picked.length} cerradas≈${Math.max(0, closedSkipped)})`);
    if (picked.length === 0) {
      await finishRun(runId, {
        status: "done",
        processed: 0,
        failed: 0,
        summary: doneSummary(0),
        pulseState: "paused",
      });
      return;
    }

    // 6. Datos para redactar los elegidos (clientes + predicción vigente).
    // P2: sin decision/p_recompra_h el refrescado cae en `unknown` en
    // Finanzas. Orden: borrador viejo → predicción vigente → null honesto.
    const pickedCids = [...new Set(picked.map((p) => p.customerId))];
    const staleById = new Map(stale.map((s) => [s.id, s]));
    const custById = new Map<string, { email: string; first_name: string | null; last_name: string | null; phone: string | null; company_name: string | null; country: string | null }>();
    for (let i = 0; i < pickedCids.length; i += 200) {
      const { data, error } = await db
        .from("customers")
        .select("id,email,first_name,last_name,phone,company_name,country")
        .in("id", pickedCids.slice(i, i + 200));
      if (error) throw new Error(`Customers read: ${error.message}`);
      for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
        custById.set(String(r.id ?? ""), {
          email: String(r.email ?? ""),
          first_name: (r.first_name as string | null) ?? null,
          last_name: (r.last_name as string | null) ?? null,
          phone: (r.phone as string | null) ?? null,
          company_name: (r.company_name as string | null) ?? null,
          country: (r.country as string | null) ?? null,
        });
      }
    }
    const predByCust = new Map<string, { decision: string | null; p: number | null }>();
    for (let i = 0; i < pickedCids.length; i += 200) {
      const { data, error } = await db
        .from("customer_predictions")
        .select("customer_id,decision,p_recompra_h,as_of")
        .eq("store_id", storeId)
        .in("customer_id", pickedCids.slice(i, i + 200))
        .order("as_of", { ascending: false })
        .order("id", { ascending: true })
        .range(0, 499);
      if (error) break;
      for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
        const cid = String(r.customer_id ?? "");
        if (!cid || predByCust.has(cid)) continue;
        const dec = typeof r.decision === "string" && r.decision ? r.decision : null;
        predByCust.set(cid, {
          decision: dec,
          p: typeof r.p_recompra_h === "number" ? (r.p_recompra_h as number) : null,
        });
      }
    }

    // 7. Un solo buildSystem por corrida (sin N+1, como runCopywriter).
    const { system, catalog, brain, inactiveNorm, inactiveLoose } = await buildSystem(storeId);
    const { isFullyOptedOut, isOptedOut } = await import("@/lib/pre-send");

    const draftedCustomer = new Set<string>();
    for (const p of picked) {
      if (drafted >= limit) break;
      if (draftedCustomer.has(p.customerId)) continue;
      const sig = sigById.get(String(p.signalId!));
      const cust = custById.get(p.customerId);
      if (!sig || !cust) {
        skipped += 1;
        continue;
      }
      const s: Prioritized = {
        id: String(p.signalId!),
        kind: sig.kind,
        objective: sig.objective,
        score: sig.score,
        reason: sig.reason,
        customer_id: p.customerId,
        email: cust.email,
        first_name: cust.first_name,
        last_name: cust.last_name,
        phone: cust.phone,
        companyName: cust.company_name,
        country: cust.country,
        decision: staleById.get(p.id)?.decision ?? predByCust.get(p.customerId)?.decision ?? null,
        pRecompraH: staleById.get(p.id)?.pRecompraH ?? predByCust.get(p.customerId)?.p ?? null,
      };
      await step(null);
      try {
        if (await isFullyOptedOut(storeId, s.customer_id)) {
          throw new OptOutSkip("baja total del destinatario (opt-out email + whatsapp)");
        }
        const { channel, body, subject, verdict } = await composeDraftCopy(db, storeId, system, s, {
          runId,
          catalog,
          brain,
          inactiveNorm,
          inactiveLoose,
        });
        if (await isOptedOut(storeId, s.customer_id, channel)) {
          throw new OptOutSkip(`baja del destinatario en ${channel} (opt-out)`);
        }
        // Re-chequeo de señal viva justo antes de mutar (no resucitar
        // closed/dismissed por carrera): solo open/prioritized/actioned.
        const { data: liveRow } = await db
          .from("churn_signals")
          .select("id,status")
          .eq("id", s.id)
          .in("status", ["open", "prioritized", "actioned"])
          .maybeSingle();
        if (!liveRow) {
          skipped += 1;
          log(`run ${runId} ${s.email || s.customer_id} omitido (señal ya no viva)`);
          continue;
        }
        // Re-chequeo anti-duplicado (un rescate manual o el bulk concurrente
        // pudo crear otro vivo mientras el LLM redactaba; p.id se excluye
        // porque es el propio stale que se reemplaza).
        await assertNoLiveDraft(db, storeId, { signalId: s.id, customerId: s.customer_id }, p.id);
        // Borrar-tras-redactar-OK por id (no tumba un aprobado concurrente:
        // el eq pending_review deja el aprobado intacto).
        const { error: delErr } = await db
          .from("proposed_actions")
          .delete()
          .eq("id", p.id)
          .eq("status", "pending_review");
        if (delErr) throw new Error(`Stale delete: ${delErr.message}`);
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
            run_id: runId,
            catalog,
            at: new Date().toISOString(),
            refreshed_from: p.id,
            contactability: {
              eligible: true,
              reusable: verdict.reusable,
              reason: verdict.reason,
              fail_open: verdict.failOpen,
              generator: JUDGE_GEN,
            },
            decision: s.decision ?? null,
            p_recompra_h: s.pRecompraH ?? null,
            kind: s.kind ?? null,
            objective: s.objective ?? null,
            reason: s.reason ?? null,
          },
        });
        if (insErr) throw new Error(`Action insert: ${insErr.message}`);
        // La señal queda con pendiente fresco: actioned. Solo se toca si
        // sigue viva (guardia .in): jamás closed/dismissed.
        await db
          .from("churn_signals")
          .update({ status: "actioned" })
          .eq("id", s.id)
          .in("status", ["open", "prioritized", "actioned"]);
        drafted += 1;
        draftedCustomer.add(s.customer_id);
        log(`run ${runId} refresh ${s.email || s.customer_id} → ${channel} (${body.length} chars)`);
      } catch (e) {
        if (e instanceof OptOutSkip) {
          skipped += 1;
          log(`run ${runId} ${s.email || s.customer_id} omitido (opt-out): ${e.message}`);
        } else if (e instanceof ContactabilitySkip) {
          skipped += 1;
          log(`run ${runId} ${s.email || s.customer_id} omitido (juez): ${e.message}`);
        } else if (e instanceof DuplicateSkip) {
          skipped += 1;
          log(`run ${runId} ${s.email || s.customer_id} omitido (duplicado): ${e.message}`);
        } else {
          failed += 1;
          log(`run ${runId} ${s.email || s.customer_id} ERROR ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    await step(null);
    const status: RunStatus = drafted === 0 && failed > 0 ? "error" : "done";
    await finishRun(runId, {
      status,
      processed: drafted,
      failed,
      summary: doneSummary(drafted),
      pulseState: drafted > 0 ? "needs" : "paused",
    });
    log(`run ${runId} ${status} actualizados=${drafted} purgados=${purged} omitidos=${skipped} fallidos=${failed} (limite=${limit})`);
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed: drafted,
      failed,
      error: formatRunError(e),
    }).catch(() => {});
    log(`run ${runId} ERROR ${e instanceof Error ? e.message : e}`);
  }
}
