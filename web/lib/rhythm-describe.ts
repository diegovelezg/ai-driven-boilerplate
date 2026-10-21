// Descripción humana del ritmo del cliente (issue #27 Paso 5.1): sustento para Review.
// Puro y apto para cliente/servidor (sin I/O): opera sobre la evidencia
// ya persistida (`mixture_k/meds/resp`). Reglas:
// - Sin mezcla (legacy o K=1) ⇒ null: la superficie no cambia.
// - Con mezcla: a qué comportamiento observado se parece, en lenguaje humano.
//   Nunca expone jerga (μ, clusters, EM) ni probabilidades de pertenencia
//   como si fueran hechos: solo el grupo dominante o la indecisión entre dos.
export interface RhythmEvidence {
  mixture_k: unknown;
  mixture_meds: unknown;
  mixture_resp: unknown;
}

function asMeds(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) return null;
  const meds: number[] = [];
  for (const m of raw) {
    const v = typeof m === "number" ? m : Number(m);
    if (!Number.isFinite(v) || v < 1 || v > 1095) return null;
    meds.push(Math.round(v));
  }
  return meds;
}

function asResp(raw: unknown, k: number): number[] | null {
  if (!Array.isArray(raw) || raw.length !== k) return null;
  const resp: number[] = [];
  let sum = 0;
  for (const r of raw) {
    const v = typeof r === "number" ? r : Number(r);
    if (!Number.isFinite(v) || v < 0 || v > 1) return null;
    sum += v;
    resp.push(v);
  }
  if (!(Math.abs(sum - 1) <= 0.01)) return null;
  return resp;
}

/** Frase de sustento para Review (actuar/vigilar) o null si no aplica. */
export function describeCustomerRhythm(ev: RhythmEvidence): string | null {
  const k = typeof ev.mixture_k === "number" && Number.isInteger(ev.mixture_k) ? ev.mixture_k : null;
  if (k === null || k < 2) return null;
  const meds = asMeds(ev.mixture_meds);
  const resp = asResp(ev.mixture_resp, k);
  if (meds === null || resp === null || meds.length !== k) return null;
  let dom = 0;
  for (let i = 1; i < k; i += 1) {
    if (resp[i] > resp[dom]) dom = i;
  }
  if (resp[dom] >= 0.6) {
    return `Su grupo de compra suele volver a los ~${meds[dom]} días.`;
  }
  const order = resp.map((_, i) => i).sort((a, b) => resp[b] - resp[a]);
  const [a, b] = [meds[order[0]], meds[order[1]]].sort((x, y) => x - y);
  return `Su ritmo está entre dos formas de comprar (grupos de ~${a} y ~${b} días).`;
}
