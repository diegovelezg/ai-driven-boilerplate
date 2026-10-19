// Autocalibración del corte de "seguimiento cercano" (issue #21, sin
// hardcodear por tienda). Etiqueta historia (p del motor → ¿volvió en su
// ventana?) y fitea el corte con J de Youden (ver `fitCloseWatchP`).
// Escribe `store_profiles.close_watch_p` (display-only, como los band cuts:
// sin HITL). Con poca historia conserva el default y lo dice.
import { getSupabase } from "@/lib/supabase";
import {
  fitCloseWatchP,
  type CloseWatchSample,
} from "@/lib/customer-predictions";
import { getStoreProfile, resolveCloseWatchP } from "@/lib/store-profiles";
import { HORIZON_BY_ARCHETYPE } from "@/lib/retention-model";

/** Ventana de historia para etiquetar (acota lecturas, no es negocio). */
const HISTORY_DAYS = 90;
/** Tope de muestras (una por cliente-día basta para el corte). */
const MAX_SAMPLES = 5000;
/** Cambio mínimo para reescribir (evita churn del parámetro por ruido). */
const WRITE_EPSILON = 0.005;

export interface CloseWatchCalibration {
  fitted: number | null;
  previous: number;
  samples: number;
  positives: number;
  wrote: boolean;
  reason: string;
}

export async function calibrateCloseWatchP(
  storeId: string,
  opts?: { dryRun?: boolean },
): Promise<CloseWatchCalibration> {
  const dryRun = opts?.dryRun === true;
  const previous = await resolveCloseWatchP(storeId).catch(() => 0.1);
  const db = getSupabase();
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();

  const profile = await getStoreProfile(storeId).catch(() => null);
  const defaultHorizon = HORIZON_BY_ARCHETYPE[profile?.archetype ?? ""] ?? 14;

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
    return { fitted: null, previous, samples: 0, positives: 0, wrote: false, reason: "Sin predicciones en ventana: se conserva el corte." };
  }

  const oldest = String(rows[rows.length - 1].as_of ?? since);
  // Índice por cliente para etiquetar por ventana (ordenado una vez).
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

  const samples: CloseWatchSample[] = [];
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
  const fitted = fitCloseWatchP(samples);
  if (fitted === null) {
    return {
      fitted: null, previous, samples: samples.length, positives, wrote: false,
      reason: `Historia insuficiente o p no discrimina (${samples.length} muestras, ${positives} retornos): se conserva ${previous}.`,
    };
  }
  if (Math.abs(fitted - previous) < WRITE_EPSILON) {
    return {
      fitted, previous, samples: samples.length, positives, wrote: false,
      reason: `Corte aprendido ${fitted} ≈ vigente ${previous}: sin escritura.`,
    };
  }
  if (!dryRun) {
    const { error } = await db
      .from("store_profiles")
      .update({ close_watch_p: fitted })
      .eq("store_id", storeId);
    if (error) throw new Error(`Close-watch write: ${error.message}`);
  }
  return {
    fitted, previous, samples: samples.length, positives,
    wrote: !dryRun,
    reason: dryRun
      ? `Dry-run: el corte pasaría de ${previous} a ${fitted} (${samples.length} muestras, ${positives} retornos).`
      : `Corte ${previous} → ${fitted} (${samples.length} muestras, ${positives} retornos).`,
  };
}
