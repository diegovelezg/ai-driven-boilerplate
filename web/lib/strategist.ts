// Strategist (Decidir, Fase A): lee señales `open` → prioriza con el ranking
// único (lib/mira, insignia + valor esperado) → `prioritized` + objetivo
// (`winback`|`nurture`|`vip_care`). Determinista, sin LLM:
// auditable y barato; el proceso `strategist_plan` de llm_models.json queda
// reservado para priorización con contexto blando futuro.
// Corre en background con `background_runs` kind `strategist`.
import { getSupabase } from "@/lib/supabase";
import { getRankedMira } from "@/lib/mira";
import { advanceRun, finishRun, setRunTotal, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { formatNumber } from "@/lib/format";

const log = createLogger("strategist");

/** Versión del criterio de priorización. Sube cuando cambia la regla. */
export const STRATEGIST_GEN = "strategist:v2:retention";

interface OpenSignal {
  id: string;
  customer_id: string;
  score: number | null;
  reason: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  orders_count: number;
  total_spent: number;
  model: string | null;
  currency: string | null;
}

export interface StrategistOpts {
  /** Máx. señales a priorizar por corrida (las de mayor valor×score). */
  limit?: number;
}

/** Objetivo según valor y frecuencia: VIP = alto gasto recurrente; winback = 1 compra (incluye 2ª compra del Modelo B); resto nurture.
 *  Issue #11: F por sesiones/modelo del motor, no por orders_count (pago partido mismo día = 1 sesión). */
function objective(o: OpenSignal, vipSpend: number): "winback" | "nurture" | "vip_care" {
  if (o.orders_count >= 3 && o.total_spent >= vipSpend) return "vip_care";
  // Modelo B (segunda_compra) o 1 sola sesión real → winback aunque
  // orders_count cuente 2 por pago partido.
  if (o.model === "segunda_compra" || o.orders_count <= 1) return "winback";
  return "nurture";
}

export async function runStrategist(
  runId: string,
  storeId: string,
  opts: StrategistOpts = {},
): Promise<void> {
  const { limit = 20 } = opts;
  const db = getSupabase();
  let prioritized = 0;
  try {
    // Mismo ranking que Overview/Review/Copywriter (lib/mira): se prioriza el
    // top real, no empates arbitrarios de score. La foránea va después.
    // Solo señales cuyo cliente esté en actuar/revision_humana (motor
    // retention:v1); si aún no hay predicciones, se prioriza sin filtrar
    // (compat pre-migración).
    const mira = await getRankedMira(storeId, 200);
    // Issue #11: percentil VIP intra-moneda-tienda. mira.rows ya es el
    // universo de la tienda; foreign (otra moneda) no entra al umbral.
    let rows = [...mira.rows, ...mira.foreign]
      .filter((r) => r.status === "open")
      .map((r) => ({
        id: r.signalId,
        customer_id: r.customerDbId,
        score: r.score,
        reason: r.reason,
        email: r.email,
        first_name: r.firstName,
        last_name: r.lastName,
        orders_count: r.ordersCount,
        total_spent: r.totalSpent,
        model: r.model ?? null,
        currency: r.currency ?? null,
        decision: r.decision ?? null,
      }) satisfies OpenSignal & { decision: string | null });
    const withPred = rows.filter((r) => r.decision !== null);
    if (withPred.length > 0) {
      rows = rows.filter((r) => r.decision === "actuar" || r.decision === "revision_humana");
    }
    // Uno por cliente (issue #9): el ranking ya viene ordenado, se queda la
    // primera señal de cada customer. Dos priorizadas del mismo cliente
    // terminan en dos borradores al mismo WhatsApp.
    {
      const seen = new Set<string>();
      const before = rows.length;
      rows = rows.filter((r) => {
        if (seen.has(r.customer_id)) return false;
        seen.add(r.customer_id);
        return true;
      });
      if (rows.length !== before) {
        log(`run ${runId} dedup_customer=${before - rows.length} señales repetidas del mismo cliente fuera`);
      }
    }
    const spends = [...rows.filter((r) => mira.rows.some((m) => m.signalId === r.id)).map((r) => r.total_spent)].sort((a, b) => a - b);
    const vipSpend = spends.length > 0 ? spends[Math.floor(spends.length * 0.8)] : 0;
    log(`run ${runId} start abiertas=${rows.length} limite=${limit} umbral_vip=${vipSpend}`);
    // Trazabilidad del ranking: si el top se discute, el log dice quién era.
    log(`run ${runId} top5=${rows.slice(0, 5).map((r) => r.email || r.customer_id).join(",")}`);

    const batch = rows.slice(0, Math.max(0, limit));
    await setRunTotal(runId, rows.length).catch(() => {});
    const topName =
      batch.length > 0
        ? [batch[0].first_name, batch[0].last_name].filter(Boolean).join(" ") || batch[0].email || "tu top"
        : null;
    let i = 0;
    for (const s of batch) {
      i += 1;
      await advanceRun(runId, { processed: prioritized, failed: 0, current: null });
      const kind = objective(s, vipSpend);
      // Issue #11 P1: kind (origen) ya no se pisa. El tratamiento va en
      // objective; kind se conserva. Ciclo scout→strategist→scout conserva
      // winback y revision_humana (test dedicado).
      const { error: upErr } = await db
        .from("churn_signals")
        .update({ status: "prioritized", objective: kind, evidence_json: { generator: STRATEGIST_GEN, run_id: runId, at: new Date().toISOString() } })
        .eq("id", s.id);
      if (upErr) {
        log(`run ${runId} ${s.email} ERROR ${upErr.message}`);
        continue;
      }
      prioritized += 1;
      log(`run ${runId} [${i}/${batch.length}] ${s.email} → prioritized objetivo=${kind} score=${s.score}`);
    }

    await advanceRun(runId, { processed: prioritized, failed: 0, current: null });
    const status: RunStatus = "done";
    // Filosofía TeamPulse: outcome + siguiente paso, no "X de Y abiertas".
    const leftover = rows.length - batch.length;
    const summary =
      prioritized > 0
        ? `Ordenó ${formatNumber(prioritized)}, empieza por ${topName}${leftover > 0 ? ` · ${formatNumber(leftover)} quedan` : ""}`
        : "Sin ordenar, nada urgente · no hay a quién priorizar";
    await finishRun(runId, {
      status,
      processed: prioritized,
      failed: 0,
      summary,
      pulseState: prioritized > 0 ? "active" : "paused",
    });
    log(`run ${runId} ${status} ${summary}`);
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed: prioritized,
      failed: 0,
      error: e instanceof Error ? e.message : String(e),
    });
    log(`run ${runId} ERROR ${e instanceof Error ? e.message : e}`);
  }
}
