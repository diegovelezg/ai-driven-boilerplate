// Critic del set perfilador: revisor adversarial de la síntesis.
// Checklist fijo; si rechaza, devuelve correcciones puntuales por slot.
// Barato (un pass) y es lo que habría atrapado el hybrid, el hibrido y el se.
import { completeProcessJson } from "./llm";
import { isKnownTaxonomyId } from "@/lib/taxonomy";
import type { Synthesis } from "./synthesizer";

export interface Critique {
  verdict: "accept" | "reject";
  /** Correcciones puntuales: solo slots que el critic cambia, con motivo. */
  corrections: Array<{ slot: string; value: string; reason: string }>;
  reasons: string[];
  /** Preguntas que sobreviven (gaps reales para el interviewer). */
  questions: string[];
}

const SYSTEM = `Eres el revisor adversarial de perfiles de negocio. Decides slot por slot.
Responde SOLO JSON válido, sin markdown:
{"verdict": "accept"|"reject", "slots": {"business_model": {"decision": "keep"|"change", "value": string, "reason": string}, "vertical": {...}, "taxonomy_id": {...}, "buyer_type": {...}, "catalog_type": {...}, "archetype": {...}, "cycle_days": {...}, "company_required": {...}}, "reasons": string[], "questions": string[]}
Checklist (slot por slot, sin excepciones):
1. business_model: ¿"hybrid"/"b2c" tiene evidencia positiva de consumo personal? Gmail masivo + dominios propios + ICP de negocios = b2b. company_name vacío no es evidencia de nada. Si la web muestra uso personal real (p.ej. saludos/eventos), puede sostener hybrid: cítalo.
2. archetype: ¿coherente con business_model? ¿el ciclo tiene fuente o es inventado?
3. taxonomy_id: ¿el nodo más preciso o uno grueso por comodidad?
4. buyer_type: ¿granularidad real (la que den datos/enriched) o genérico?
5. cycle_days y company_required: ¿justificados o default silencioso?
- slots: UN veredicto por cada uno de los 8 slots (keep con value = el actual, o change con el nuevo valor). "value" siempre el valor final que debe quedar.
- verdict: reject si algún slot es change, accept si todos keep.
- reasons: 1-4 líneas. questions: máx 2, solo gaps que ni la evidencia cierra.`;

const SLOTS = new Set([
  "business_model", "vertical", "taxonomy_id", "buyer_type",
  "catalog_type", "archetype", "cycle_days", "company_required",
]);

/** Revisa la síntesis contra la evidencia cruda. Lanza si el LLM falla. */
export async function critique(synthesis: Synthesis, evidence: string, opts: { storeId?: string | null } = {}): Promise<Critique> {
  const user = `SÍNTESIS:\n${JSON.stringify(synthesis).slice(0, 3000)}\n\nEVIDENCIA CRUDA:\n${evidence.slice(0, 4000)}`;
  const raw = await completeProcessJson("profiler_critic", SYSTEM, user, opts.storeId ? { storeId: opts.storeId } : {});
  const p = JSON.parse(raw) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const slots = (p.slots ?? {}) as Record<string, Record<string, unknown>>;
  const corrections: Critique["corrections"] = [];
  for (const slot of SLOTS) {
    const s = slots[slot];
    if (!s || typeof s !== "object") continue;
    if (str(s.decision) !== "change") continue;
    const value = str(s.value);
    const reason = str(s.reason);
    if (!value || !reason) continue;
    if (slot === "taxonomy_id" && !isKnownTaxonomyId(value)) continue;
    corrections.push({ slot, value: value.slice(0, 120), reason: reason.slice(0, 200) });
  }
  const verdict = corrections.length > 0 ? "reject" : "accept";
  return {
    verdict,
    corrections,
    reasons: Array.isArray(p.reasons)
      ? p.reasons.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 4)
      : [],
    questions: Array.isArray(p.questions)
      ? p.questions.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 2)
      : [],
  };
}
