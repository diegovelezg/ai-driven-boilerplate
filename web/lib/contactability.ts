// Puerta de contactabilidad (issue #9): un juez LLM barato decide con sensatez
// si TIENE SENTIDO contactar hoy al cliente por este contenido, ANTES de
// redactar. El ranking (lib/mira) y el strategist siguen 100% deterministas;
// este es el paso posterior que pone la sensatez. Agnóstico por diseño: el
// código no trae ninguna lista de palabras ni regex; solo arma el dossier con
// datos estructurados (contenido enriquecido + ventanas dateStart/dateEnd +
// hoy + silencio) y el modelo razona. Sin columnas nuevas ni estados nuevos:
// el veredicto vive en `evidence_json.contactability`.
// Fail-open: si el juez falla (llave, red, JSON roto), se redacta igual y el
// ranking determinista manda. La puerta nunca vacía la cola por infra.
import { createLogger } from "@/lib/log";
import { chatCompletionParams, getLlmConfig, reasoningBody, type ModelRef } from "@/lib/ai/llm-config";
import { parseJudgeResponse } from "@/lib/judge-brief";

export { parseJudgeResponse };

const log = createLogger("contactability");

/** Sello del criterio juez. Sube cuando cambia el prompt/reglas. */
export const JUDGE_GEN = "contactability:v4:reutilizable";

const JUDGE_SYSTEM = `Eres el filtro de pertinencia de un motor de retención (español Perú).
El dossier es HISTORIAL de compras pasadas, no la invitación futura. Una ventana pasada es lo normal y NUNCA es motivo de veto.
Responde SOLO con un objeto JSON válido, sin markdown: {"contactable": true|false, "reusable": true|false, "reason": "una línea, máx 140 caracteres"}.
contactable=false SOLO si ni reconociendo quién es hay algo útil que proponer hoy sin inventar datos, fechas, nombres, ofertas o ubicaciones. Inventar = proponer lo que no está en el dossier ni en la capacidad general.
reusable=false si lo comprado solo tenía sentido en su ventana: sirve para reconocer quién es, no para repetirlo como propuesta.
Por defecto {"contactable": true, "reusable": true}. Ante cualquier duda, true/true.`;

export interface JudgeItem {
  title: string;
  contiene: string | null;
  categoria: string | null;
  clienteDijo: string | null;
  /** Ventana ya resuelta ("A→B" partida en inicio/fin) o nulls. */
  dateStart: string | null;
  dateEnd: string | null;
}

export interface JudgeDossier {
  firstName: string;
  companyName: string | null;
  objetivo: string;
  daysSince: number | null;
  todayIso: string;
  items: JudgeItem[];
}

/** Dossier de texto para el juez (compacto: lo que necesita, nada más). */
function buildJudgeDossier(d: JudgeDossier): string {
  const lines = [
    `Cliente: ${d.firstName}${d.companyName ? ` — ${d.companyName}` : ""} (objetivo ${d.objetivo})`,
    `Hoy: ${d.todayIso}. Días sin comprar: ${d.daysSince ?? "?"}.`,
    `Historial pasado (no es la oferta; no vetes por fechas):`,
  ];
  for (const it of d.items.slice(0, 6)) {
    const bits = [
      it.title || "pieza sin título",
      it.contiene ? `contiene "${it.contiene}"` : "",
      it.categoria ? `[${it.categoria}]` : "",
      it.clienteDijo ? `cliente dijo: "${it.clienteDijo.slice(0, 100)}"` : "",
      it.dateStart || it.dateEnd
        ? `ventana ${it.dateStart ?? "?"}→${it.dateEnd ?? "?"}`
        : "sin ventana",
    ].filter(Boolean);
    lines.push(`- ${bits.join(" · ")}`);
  }
  return lines.join("\n");
}

async function completeJudge(ref: ModelRef, system: string, user: string, opts: { maxTokens: number; effort: string | null; meter?: { storeId?: string | null; usedFallback?: boolean } }): Promise<string> {
  const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
  if (!apiKey) throw new Error(`Falta ${ref.apiKeyEnv}`);
  const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const meter = opts.meter;
  const body: Record<string, unknown> = {
    model: ref.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // Sin hardcodear: el presupuesto viene de llm_models.json
    // (contactability_judge: 800). Con 300 fijos el thinking consumía todo
    // y la respuesta salía vacía (finish=length) en ambos proveedores.
    ...chatCompletionParams(ref.provider, ref.model, 0.1, opts.maxTokens),
    response_format: { type: "json_object" },
    ...reasoningBody(ref.provider, ref.model, opts.effort),
  };
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${ref.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (meter?.storeId) {
    const { parseChatUsage, logLlmUsage } = await import("@/lib/ai/usage");
    const usage = parseChatUsage(data);
    if (usage) {
      void logLlmUsage({
        storeId: meter.storeId,
        process: "contactability_judge",
        provider: ref.provider,
        model: ref.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
        latencyMs: Date.now() - t0,
        usedFallback: meter.usedFallback ?? false,
      });
    }
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    const fr = data?.choices?.[0]?.finish_reason ?? "?";
    const u = data?.usage?.completion_tokens_details ?? data?.usage ?? null;
    throw new Error(`${ref.provider}: respuesta vacía (finish=${fr} usage=${JSON.stringify(u)})`);
  }
  return content;
}

export interface JudgeVerdict {
  contactable: boolean;
  /** false = el historial solo sirve para reconocer quién es, no para repetirlo. */
  reusable: boolean;
  reason: string;
  /** true cuando el veredicto es fail-open (el juez no pudo decidir). */
  failOpen: boolean;
}

/** Pasa el dossier por el juez. Nunca lanza: ante cualquier fallo, fail-open. */
export async function judgeContactability(dossier: JudgeDossier, opts: { storeId?: string | null } = {}): Promise<JudgeVerdict> {
  const user = buildJudgeDossier(dossier);
  try {
    const cfg = getLlmConfig("contactability_judge");
    let raw: string;
    try {
      raw = await completeJudge(cfg.primary, JUDGE_SYSTEM, user, { maxTokens: cfg.maxTokens, effort: cfg.reasoningEffort, meter: { storeId: opts.storeId } });
    } catch (e) {
      if (!cfg.fallback) throw e;
      log(`primario ${cfg.primary.model} falló (${e instanceof Error ? e.message : e}); fallback a ${cfg.fallback.model}`);
      raw = await completeJudge(cfg.fallback, JUDGE_SYSTEM, user, { maxTokens: cfg.maxTokens, effort: cfg.reasoningEffort, meter: { storeId: opts.storeId, usedFallback: true } });
    }
    const parsed = parseJudgeResponse(raw);
    return { ...parsed, failOpen: false };
  } catch (e) {
    log(`juez no disponible (${e instanceof Error ? e.message : e}): fail-open en modo identidad seguro`);
    return { contactable: true, reusable: false, reason: "juez no disponible (fail-open)", failOpen: true };
  }
}
