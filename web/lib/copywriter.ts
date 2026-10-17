// Copywriter (Proponer, Fase A): por señal `prioritized` redacta
// WhatsApp/email con historial real → `proposed_actions` `pending_review`.
// Nunca envía: el humano aprueba en /review y el dispatcher ejecuta.
// LLM vía proceso `proposer_draft` (primario → fallback). Corre en
// background con `background_runs` kind `copywriter`.
import { getSupabase } from "@/lib/supabase";
import { getRankedMira } from "@/lib/mira";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { getStoreProfile, type CatalogType } from "@/lib/store-profiles";
import { chatCompletionParams, getLlmConfig, reasoningBody, type ModelRef } from "@/lib/ai/llm-config";

const log = createLogger("copywriter");

/** Versión del criterio generador. Sube cuando cambia el prompt/reglas:
 *  el regenerador solo rehace pendientes con sello viejo. */
import { COPYWRITER_GEN } from "./copywriter-gen";

export { COPYWRITER_GEN };

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

const SYSTEM = `Redactas WhatsApp B2B de recupero para vía pública (español Perú, directo, profesional, cero cursi).
Responde SOLO con un objeto JSON válido, sin markdown, con este esquema exacto:
{"channel": "whatsapp"|"email", "subject": string|null, "body": string}
Reglas duras (si las rompes el mensaje se rechaza):
- ANCLA OBLIGATORIA: cada mensaje lleva UN dato que solo aplica a ese cliente: fecha exacta de su última pauta + 1 ubicación real + su ritmo o su silencio (ej "pautabas cada ~22d y ya van 30", "llevas 219d sin pautar tras 2 campañas en Gamarra"). PROHIBIDO el mensaje genérico intercambiable entre clientes.
- FRASES PROHIBIDAS (nunca las uses, ni con variantes): "podemos ayudarte a revisar opciones", "estamos aquí para ayudarte", "si estás pensando en volver a pautar", "¿te interesa?", "¿te gustaría retomarlo?", "planificar tu próxima campaña". Son plantilla de 1990.
- Tono por objetivo (viene en el brief):
  · vip_care = cliente leal (3+ pautas, gasto top): reconoce historial en 1 línea, trato 1-a-1, oferta concreta (mismo circuito / prioridad de espacios). No ruegues.
  · nurture = tenía hábito y se cortó: nombra el quiebre de ritmo y da 1 lectura útil (repite su zona fuerte o prueba zona nueva según su patrón).
  · winback = 1-2 compras: simple, baja fricción, una sola propuesta concreta.
- CTA SIEMPRE concreto y respondible con "sí" (ej "¿te reservo el mismo circuito para noviembre? Respóndeme sí y te paso disponibilidad"). PROHIBIDA la pregunta abierta vaga.
- Nunca menciones score, media, ciclo, arquetipo ni cifras internas: solo lo que el cliente reconocería (fechas, lugares, su propio ritmo).
- Basa el mensaje en el historial real dado. NO inventes ubicaciones ni fechas.
- Empieza con "Hola {primer nombre}," (solo primer nombre, nunca apellido ni email).
- whatsapp: máximo 400 caracteres, 2-4 frases cortas, sin asunto (subject null). email: subject corto + body de máximo 1200 caracteres.
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
];

function hasBanned(body: string): boolean {
  const b = body.toLowerCase();
  return BANNED.some((p) => b.includes(p));
}

/** "sin comprar hace 219d (media 60d, 2 compras, ciclo arquetipo)" → partes. */
function parseReason(reason: string | null): {
  days: number | null;
  expected: number | null;
  source: string | null;
} {
  if (!reason) return { days: null, expected: null, source: null };
  const m = reason.match(/sin comprar hace (\d+)d\s*\(media (\d+)d,[^,]*,\s*ciclo (\w+)\)/i);
  if (!m) {
    const d = reason.match(/sin comprar hace (\d+)d/i);
    return { days: d ? Number(d[1]) : null, expected: null, source: null };
  }
  return { days: Number(m[1]), expected: Number(m[2]), source: m[3] };
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
  score: number | null;
  reason: string | null;
  customer_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  /** ISO2 atribuido (filtro global; se escribe en la acción). */
  country: string | null;
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
  const real = (((orders ?? []) as Array<Record<string, unknown>>).filter((o) => {
    if (o.is_test === true) return false;
    const st = typeof o.status === "string" ? o.status.toLowerCase() : "";
    return !["cancelled", "canceled", "archived", "refunded"].includes(st);
  })).slice(0, 5);
  // Historial legible: fecha corta + ubicaciones reales (sin "x0", sin moneda).
  const histLines = real.map((o) => {
    const iso = String(o.placed_at ?? "?").slice(0, 10);
    const f = fechaCorta(String(o.placed_at ?? "")) ?? iso;
    const items = ((o.items_json as Array<Record<string, unknown>>) ?? [])
      .map((i) => String(i.title ?? "").trim())
      .filter((t) => t && t !== "—")
      .slice(0, 4)
      .join(" · ");
    return `- ${f} (${iso}): ${items || "pauta sin detalle"}`;
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
  const patron =
    top && top[1] >= 2
      ? `REPITE: su zona fuerte es "${top[0]}" (${top[1]} veces en últimas ${real.length} pautas)`
      : distinct >= 3
        ? `EXPLORA: prueba zonas distintas (${distinct} ubicaciones distintas, sin repetir)`
        : top
          ? `mixto: última zona "${top[0]}"`
          : "sin patrón legible";
  const firstName = (s.first_name ?? "").trim().split(/\s+/)[0] || s.email;
  const r = parseReason(s.reason);
  const days = r.days;
  const lastIso = real[0] ? String(real[0].placed_at ?? "").slice(0, 10) : null;
  const lastF = real[0] ? (fechaCorta(String(real[0].placed_at ?? "")) ?? lastIso) : null;
  // Ritmo: solo el ciclo "cliente" es ritmo propio citable; tienda/arquetipo
  // es referencia interna y NO se le dice al cliente ("cada 60d" suena a call center).
  const ritmo =
    r.source === "cliente" && r.expected
      ? `ritmo propio: pautaba cada ~${r.expected}d (medido de sus compras) → quiebre real`
      : r.expected
        ? `sin ritmo propio medible (referencia interna ${r.expected}d, NO citar)`
        : "sin ritmo medible";
  const objetivo =
    s.kind === "vip_care"
      ? "vip_care: cliente leal, reconoce historial + oferta 1-a-1 concreta"
      : s.kind === "winback"
        ? "winback: 1-2 compras, simple y baja fricción"
        : "nurture: tenía hábito y se cortó, nombra el quiebre + 1 lectura útil";

  const user = [
    `Cliente: ${firstName} (objetivo ${objetivo})`,
    `Última pauta: ${lastF ?? "?"}${lastIso ? ` (${lastIso})` : ""}, hace ${days ?? "?"} días. ${ritmo}.`,
    `Patrón: ${patron}.`,
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

  let { channel, body, subject } = await attempt(null);
  if (!body) throw new Error("El LLM devolvió body vacío.");
  if (hasBanned(body)) {
    const retry = await attempt("tu borrador anterior sonaba a plantilla genérica; reescribe con el ancla específica del cliente y CTA concreto, sin ninguna frase prohibida.");
    if (hasBanned(retry.body)) throw new Error("Borrador con frase plantilla (rechazado por control de calidad).");
    ({ channel, body, subject } = retry);
  }
  if (channel === "whatsapp" && body.length > 600) throw new Error("WhatsApp demasiado largo (>600).");
  if (body.length > 2000) throw new Error("Body demasiado largo (>2000).");

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
    .select("id")
    .eq("signal_id", signalId)
    .in("status", ["pending_review", "approved"])
    .limit(1);
  if ((busy ?? []).length > 0) {
    return { ok: false, message: "Ya tiene un borrador en Review." };
  }
  try {
    const { system, catalog } = await buildSystem(storeId);
    const { channel } = await draftForSignal(db, storeId, system, {
      id: found.signalId,
      kind: found.kind,
      score: found.score,
      reason: found.reason,
      customer_id: found.customerDbId,
      email: found.email,
      first_name: found.firstName,
      last_name: found.lastName,
      phone: found.phone,
      country: found.country,
    }, { runId: null, catalog });
    return { ok: true, message: `Borrador (${channel}) listo en Review.` };
  } catch (e) {
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
        score: r.score,
        reason: r.reason,
        customer_id: r.customerDbId,
        email: r.email,
        first_name: r.firstName,
        last_name: r.lastName,
        phone: r.phone,
        country: r.country,
      }) satisfies Prioritized);
    log(`run ${runId} start priorizadas=${rows.length} limite=${limit}`);
    // Trazabilidad del ranking: si el top se discute, el log dice quién era.
    log(`run ${runId} top10=${rows.slice(0, 10).map((r) => r.email || r.customer_id).join(",")}`);

    // Sin borrador pendiente/aprobado para la misma señal (no duplicar).
    const { data: existing } = await db
      .from("proposed_actions")
      .select("signal_id")
      .eq("store_id", storeId)
      .in("status", ["pending_review", "approved"])
      .not("signal_id", "is", null)
      .limit(500);
    const busy = new Set(
      ((existing ?? []) as Array<Record<string, unknown>>).map((a) => String(a.signal_id)),
    );
    const fresh = rows.filter((r) => !busy.has(r.id));
    const batch = fresh.slice(0, Math.max(0, limit));
    log(`run ${runId} candidatas=${batch.length} (con borrador: ${rows.length - fresh.length})`);

    // Lenguaje de compra del tenant (1 query por corrida, no por borrador):
    // sin esto el redactor trata todo como bodega (“llevaste un Rp Cajamarca”).
    const { system, catalog } = await buildSystem(storeId);

    for (const s of batch) {
      await step(s.email || s.customer_id);
      try {
        const { channel, chars } = await draftForSignal(db, storeId, system, s, { runId, catalog });
        drafted += 1;
        log(`run ${runId} ${s.email} → ${channel} (${chars} chars)`);
      } catch (e) {
        failed += 1;
        log(`run ${runId} ${s.email || s.customer_id} ERROR ${e instanceof Error ? e.message : e}`);
      }
    }

    await step(null);
    const status: RunStatus = drafted === 0 && failed > 0 ? "error" : "done";
    const summary = `${drafted} borradores · ${failed} fallidos`;
    await finishRun(runId, { status, processed: drafted, failed, summary });
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
