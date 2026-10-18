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

const log = createLogger("contactability");

/** Sello del criterio juez. Sube cuando cambia el prompt/reglas. */
export const JUDGE_GEN = "contactability:v1:llm-judge";

const JUDGE_SYSTEM = `Eres el filtro de contactabilidad de un motor de retención (español Perú).
Decides si TIENE SENTIDO contactar HOY a este cliente por este contenido.
Responde SOLO con un objeto JSON válido, sin markdown: {"contactable": true|false, "reason": "una línea, máx 140 caracteres"}.
NO contactable: homenaje o cumpleaños fuera de su aniversario; evento, función, estreno o campaña cuya ventana ya pasó (dateEnd pasado sin aniversario cercano); pieza fechada ya vencida ("ahora en cines", fechas concretas pasadas).
SÍ contactable: negocio continuo (tienda, marca, servicio vigente) aunque su última pauta haya terminado hace tiempo. El fin del vuelo publicitario NO es el fin del negocio: si el cliente sigue operando, se le puede invitar a volver.
Basa tu decisión SOLO en los datos del dossier. Si dudas por falta de información, contactable=true.`;

export interface JudgeItem {
  title: string;
  contiene: string | null;
  categoria: string | null;
  clienteDijo: string | null;
  /** Ventana del vuelo (metadata.dateStart/dateEnd) o null. */
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
export function buildJudgeDossier(d: JudgeDossier): string {
  const lines = [
    `Cliente: ${d.firstName}${d.companyName ? ` — ${d.companyName}` : ""} (objetivo ${d.objetivo})`,
    `Hoy: ${d.todayIso}. Días sin comprar: ${d.daysSince ?? "?"}.`,
    `Contenido real (usa solo esto para decidir):`,
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

async function completeJudge(ref: ModelRef, system: string, user: string): Promise<string> {
  const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
  if (!apiKey) throw new Error(`Falta ${ref.apiKeyEnv}`);
  const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: ref.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...chatCompletionParams(ref.provider, ref.model, 0.1, 300),
    response_format: { type: "json_object" },
    ...reasoningBody(ref.provider, ref.model, "low"),
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

export interface JudgeVerdict {
  contactable: boolean;
  reason: string;
  /** true cuando el veredicto es fail-open (el juez no pudo decidir). */
  failOpen: boolean;
}

/** Pasa el dossier por el juez. Nunca lanza: ante cualquier fallo, fail-open. */
export async function judgeContactability(dossier: JudgeDossier): Promise<JudgeVerdict> {
  const user = buildJudgeDossier(dossier);
  try {
    const cfg = getLlmConfig("contactability_judge");
    let raw: string;
    try {
      raw = await completeJudge(cfg.primary, JUDGE_SYSTEM, user);
    } catch (e) {
      if (!cfg.fallback) throw e;
      log(`primario ${cfg.primary.model} falló (${e instanceof Error ? e.message : e}); fallback a ${cfg.fallback.model}`);
      raw = await completeJudge(cfg.fallback, JUDGE_SYSTEM, user);
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const contactable = parsed.contactable !== false;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 140)
        : contactable
          ? "sin motivo de no-contacto en el dossier"
          : "el juez no dio motivo";
    return { contactable, reason, failOpen: false };
  } catch (e) {
    log(`juez no disponible (${e instanceof Error ? e.message : e}): fail-open`);
    return { contactable: true, reason: "juez no disponible (fail-open)", failOpen: true };
  }
}
