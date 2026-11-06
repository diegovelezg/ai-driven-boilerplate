// Autocalibración de bandas p por tenant (multitenant, cadencia 30d).
// Par de `close-watch-calibrate.ts` (display-only) pero con consecuencias:
// bandHigh/Low SÍ tocan `decision` vía bandaP, así que los requisitos son más
// estrictos (más historia, trust region, margen high-low). Con poca historia
// o p no discriminativa conserva los defaults del arquetipo y lo dice.
// Patrón multitenant: el estado vive en Postgres (p_band_calibrated_at,
// p_band_samples/events), nunca en archivos locales: N tenants × N réplicas
// no deben recalibrar por su cuenta. Throttle 30d por tenant.
// Enganche: `profile-recalibrate/service.ts` (post-import, junto a closeWatch).
import { getSupabase } from "@/lib/supabase";
import { getStoreProfile, resolveBandCuts } from "@/lib/store-profiles";
import { HORIZON_BY_ARCHETYPE } from "@/lib/retention-model";

/** Ventana de historia para etiquetar (acota lecturas, no es negocio). */
const HISTORY_DAYS = 90;
/** Tope de muestras (una fila por predicción, cap como closeWatch). */
const MAX_SAMPLES = 5000;
/** Historia mínima para mover bandas que SÍ deciden (closeWatch pide 30/5). */
export const BAND_FIT_MIN_SAMPLES = 100;
export const BAND_FIT_MIN_PER_CLASS = 10;
/** Guardarraíles anti-degenerado (no son negocio: evitan "todo lejos" o
 *  "todo orgánico" con historia rala). */
export const BAND_LOW_MIN = 0.02;
export const BAND_LOW_MAX = 0.3;
export const BAND_HIGH_MIN = 0.3;
export const BAND_HIGH_MAX = 0.8;
/** Margen mínimo high-low (bandas colapsadas = decisión binaria ruidosa). */
export const BAND_MIN_GAP = 0.15;
/** Cambio mínimo para reescribir (evita churn del parámetro por ruido). */
const WRITE_EPSILON = 0.02;
/** Paso máximo por ciclo (trust region: converge sin saltos). */
const MAX_STEP = 0.1;
/** Cadencia por tenant (diseño multitenant: cada tenant tiene su reloj). */
export const BAND_CALIBRATION_DAYS = 30;
/** Precisión mínima del grupo sobre-high para aceptar high (n>=5). */
const HIGH_MIN_PRECISION = 0.45;
const HIGH_MIN_N = 5;

export interface BandSample {
  p: number;
  returned: boolean;
}

/**
 * Corte low aprendido (Youden J, como fitCloseWatchP pero con mínimos más
 * altos). Null si poca historia o p no discrimina: el llamador conserva.
 */
export function fitBandLow(samples: BandSample[]): number | null {
  const rows = samples.filter((s) => Number.isFinite(s.p) && s.p >= 0 && s.p <= 1);
  if (rows.length < BAND_FIT_MIN_SAMPLES) return null;
  const pos = rows.filter((s) => s.returned).length;
  const neg = rows.length - pos;
  if (pos < BAND_FIT_MIN_PER_CLASS || neg < BAND_FIT_MIN_PER_CLASS) return null;
  const candidates = [...new Set(rows.map((s) => s.p))].sort((a, b) => a - b);
  let best: number | null = null;
  let bestJ = 0;
  for (const c of candidates) {
    const tp = rows.filter((s) => s.returned && s.p >= c).length;
    const fp = rows.filter((s) => !s.returned && s.p >= c).length;
    const j = tp / pos + (neg - fp) / neg - 1;
    if (j > bestJ + 1e-9) {
      bestJ = j;
      best = c;
    }
  }
  if (best === null) return null;
  const clamped = Math.min(BAND_LOW_MAX, Math.max(BAND_LOW_MIN, best));
  return Math.round(clamped * 100) / 100;
}

/**
 * Corte high aprendido: el menor p tal que el grupo p>=high tiene precisión
 * >= HIGH_MIN_PRECISION con n>=HIGH_MIN_N. Null si ningún grupo califica
 * (p. ej. maxP bajo o base rala): el llamador conserva el default.
 */
export function fitBandHigh(samples: BandSample[]): number | null {
  const rows = samples.filter((s) => Number.isFinite(s.p) && s.p >= 0 && s.p <= 1);
  if (rows.length < BAND_FIT_MIN_SAMPLES) return null;
  const pos = rows.filter((s) => s.returned).length;
  if (pos < BAND_FIT_MIN_PER_CLASS) return null;
  const candidates = [...new Set(rows.map((s) => s.p))].sort((a, b) => a - b);
  for (const c of candidates) {
    if (c < BAND_HIGH_MIN || c > BAND_HIGH_MAX) continue;
    const group = rows.filter((s) => s.p >= c);
    if (group.length < HIGH_MIN_N) continue;
    const prec = group.filter((s) => s.returned).length / group.length;
    if (prec >= HIGH_MIN_PRECISION) return Math.round(c * 100) / 100;
  }
  return null;
}

export interface BandCalibration {
  fittedHigh: number | null;
  fittedLow: number | null;
  previousHigh: number;
  previousLow: number;
  samples: number;
  positives: number;
  wrote: boolean;
  reason: string;
}

export async function calibrateBandCuts(
  storeId: string,
  opts?: { dryRun?: boolean; nowMs?: number },
): Promise<BandCalibration> {
  const dryRun = opts?.dryRun === true;
  const nowMs = opts?.nowMs ?? Date.now();
  const prev = await resolveBandCuts(storeId).catch(() => ({ high: 0.6, low: 0.15 }));
  const db = getSupabase();
  const since = new Date(nowMs - HISTORY_DAYS * 86_400_000).toISOString();

  // Throttle 30d por tenant (multitenant: cada tenant su reloj en Postgres).
  try {
    const { data: st } = await db
      .from("store_profiles")
      .select("p_band_calibrated_at")
      .eq("store_id", storeId)
      .maybeSingle();
    const last = (st as Record<string, unknown> | null)?.p_band_calibrated_at;
    const lastMs = typeof last === "string" ? Date.parse(last) : NaN;
    if (!dryRun && Number.isFinite(lastMs) && nowMs - lastMs < BAND_CALIBRATION_DAYS * 86_400_000) {
      const days = Math.max(0, Math.round((nowMs - lastMs) / 86_400_000));
      return {
        fittedHigh: null, fittedLow: null,
        previousHigh: prev.high, previousLow: prev.low,
        samples: 0, positives: 0, wrote: false,
        reason: `Calibrado hace ${days}d (<${BAND_CALIBRATION_DAYS}d): se conserva ${prev.high}/${prev.low}.`,
      };
    }
  } catch {
    // Sin estado legible no se frena: se evalúa y el write lo sella.
  }

  const profile = await getStoreProfile(storeId).catch(() => null);
  const defaultHorizon = HORIZON_BY_ARCHETYPE[profile?.archetype ?? ""] ?? 60;

  const { data: preds, error: pErr } = await db
    .from("customer_predictions")
    .select("customer_id,p_recompra_h,as_of,horizon_days")
    .eq("store_id", storeId)
    .gte("as_of", since)
    .order("as_of", { ascending: false })
    .limit(MAX_SAMPLES);
  if (pErr) throw new Error(`Predictions read: ${pErr.message}`);
  const rows = ((preds ?? []) as Array<Record<string, unknown>>).filter(
    (r) => r.p_recompra_h != null && r.as_of != null && r.customer_id != null,
  );
  if (rows.length === 0) {
    return {
      fittedHigh: null, fittedLow: null,
      previousHigh: prev.high, previousLow: prev.low,
      samples: 0, positives: 0, wrote: false,
      reason: "Sin predicciones en ventana: se conservan bandas.",
    };
  }

  const oldest = String(rows[rows.length - 1].as_of ?? since);
  const byCust = new Map<string, number[]>();
  {
    const { data, error } = await db
      .from("orders")
      .select("customer_id,placed_at")
      .eq("store_id", storeId)
      .gte("placed_at", oldest)
      .order("placed_at", { ascending: true })
      .limit(20000);
    if (error) throw new Error(`Orders read: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const cid = String(r.customer_id ?? "");
      const t = Date.parse(String(r.placed_at ?? ""));
      if (!cid || Number.isNaN(t)) continue;
      const arr = byCust.get(cid) ?? [];
      arr.push(t);
      byCust.set(cid, arr);
    }
  }

  const samples: BandSample[] = [];
  for (const r of rows) {
    const p = Number(r.p_recompra_h);
    if (!Number.isFinite(p)) continue;
    const asOf = Date.parse(String(r.as_of ?? ""));
    if (Number.isNaN(asOf)) continue;
    const horizon = r.horizon_days == null ? defaultHorizon : Number(r.horizon_days);
    const end = asOf + (Number.isFinite(horizon) && horizon > 0 ? horizon : defaultHorizon) * 86_400_000;
    const times = byCust.get(String(r.customer_id ?? "")) ?? [];
    const returned = times.some((t) => t > asOf && t <= end);
    samples.push({ p, returned });
    if (samples.length >= MAX_SAMPLES) break;
  }
  const positives = samples.filter((s) => s.returned).length;
  const rawLow = fitBandLow(samples);
  const rawHigh = fitBandHigh(samples);
  if (rawLow === null && rawHigh === null) {
    return {
      fittedHigh: null, fittedLow: null,
      previousHigh: prev.high, previousLow: prev.low,
      samples: samples.length, positives, wrote: false,
      reason: `Historia insuficiente o p no discrimina (${samples.length} muestras, ${positives} retornos): se conservan ${prev.high}/${prev.low}.`,
    };
  }
  // Invariante high-low: si solo un lado fiteó, se ancla el otro con gap mínimo.
  let targetHigh = rawHigh ?? Math.max(prev.high, (rawLow ?? prev.low) + BAND_MIN_GAP);
  let targetLow = rawLow ?? Math.min(prev.low, (rawHigh ?? prev.high) - BAND_MIN_GAP);
  targetHigh = Math.min(BAND_HIGH_MAX, Math.max(BAND_HIGH_MIN, targetHigh));
  targetLow = Math.min(BAND_LOW_MAX, Math.max(BAND_LOW_MIN, targetLow));
  if (!(targetHigh > targetLow + BAND_MIN_GAP - 1e-9)) {
    return {
      fittedHigh: null, fittedLow: null,
      previousHigh: prev.high, previousLow: prev.low,
      samples: samples.length, positives, wrote: false,
      reason: `Fiteo degenerado (high ${targetHigh} vs low ${targetLow}): se conservan ${prev.high}/${prev.low}.`,
    };
  }
  // Trust region: paso máximo MAX_STEP por ciclo hacia el objetivo.
  const step = (from: number, to: number) =>
    Math.abs(to - from) <= MAX_STEP ? to : from + Math.sign(to - from) * MAX_STEP;
  const nextHigh = Math.round(step(prev.high, targetHigh) * 100) / 100;
  const nextLow = Math.round(step(prev.low, targetLow) * 100) / 100;
  if (Math.abs(nextHigh - prev.high) < WRITE_EPSILON && Math.abs(nextLow - prev.low) < WRITE_EPSILON) {
    return {
      fittedHigh: nextHigh, fittedLow: nextLow,
      previousHigh: prev.high, previousLow: prev.low,
      samples: samples.length, positives, wrote: false,
      reason: `Bandas aprendidas ${nextHigh}/${nextLow} ≈ vigentes ${prev.high}/${prev.low}: sin escritura.`,
    };
  }
  if (!dryRun) {
    const { error } = await db
      .from("store_profiles")
      .update({
        p_band_high: nextHigh,
        p_band_low: nextLow,
        p_band_calibrated_at: new Date(nowMs).toISOString(),
        p_band_samples: samples.length,
        p_band_events: positives,
      })
      .eq("store_id", storeId);
    if (error) throw new Error(`Band cuts write: ${error.message}`);
  }
  return {
    fittedHigh: nextHigh, fittedLow: nextLow,
    previousHigh: prev.high, previousLow: prev.low,
    samples: samples.length, positives,
    wrote: !dryRun,
    reason: dryRun
      ? `Dry-run: bandas pasarían de ${prev.high}/${prev.low} a ${nextHigh}/${nextLow} (${samples.length} muestras, ${positives} retornos).`
      : `Bandas ${prev.high}/${prev.low} → ${nextHigh}/${nextLow} (${samples.length} muestras, ${positives} retornos).`,
  };
}
