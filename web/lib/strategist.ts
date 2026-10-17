// Strategist (Decidir, Fase A): lee señales `open` → prioriza con el ranking
// único (lib/mira, insignia + valor esperado) → `prioritized` + objetivo
// (`winback`|`nurture`|`vip_care`). Determinista, sin LLM:
// auditable y barato; el proceso `strategist_plan` de llm_models.json queda
// reservado para priorización con contexto blando futuro.
// Corre en background con `background_runs` kind `strategist`.
import { getSupabase } from "@/lib/supabase";
import { getRankedMira } from "@/lib/mira";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";

const log = createLogger("strategist");

/** Versión del criterio de priorización. Sube cuando cambia la regla. */
export const STRATEGIST_GEN = "strategist:v1:mira";

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
}

export interface StrategistOpts {
  /** Máx. señales a priorizar por corrida (las de mayor valor×score). */
  limit?: number;
}

/** Objetivo según valor y frecuencia: VIP = alto gasto recurrente; winback = 1 compra; resto nurture. */
function objective(o: OpenSignal, vipSpend: number): "winback" | "nurture" | "vip_care" {
  if (o.orders_count >= 3 && o.total_spent >= vipSpend) return "vip_care";
  if (o.orders_count <= 1) return "winback";
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
    const mira = await getRankedMira(storeId, 200);
    const rows = [...mira.rows, ...mira.foreign]
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
      }) satisfies OpenSignal);
    const spends = [...rows.map((r) => r.total_spent)].sort((a, b) => a - b);
    const vipSpend = spends.length > 0 ? spends[Math.floor(spends.length * 0.8)] : 0;
    log(`run ${runId} start abiertas=${rows.length} limite=${limit} umbral_vip=${vipSpend}`);
    // Trazabilidad del ranking: si el top se discute, el log dice quién era.
    log(`run ${runId} top5=${rows.slice(0, 5).map((r) => r.email || r.customer_id).join(",")}`);

    const batch = rows.slice(0, Math.max(0, limit));
    let i = 0;
    for (const s of batch) {
      i += 1;
      await advanceRun(runId, { processed: prioritized, failed: 0, current: s.email || s.customer_id });
      const kind = objective(s, vipSpend);
      const { error: upErr } = await db
        .from("churn_signals")
        .update({ status: "prioritized", kind, evidence_json: { generator: STRATEGIST_GEN, run_id: runId, at: new Date().toISOString() } })
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
    const summary = `${prioritized} priorizadas de ${rows.length} abiertas`;
    await finishRun(runId, { status, processed: prioritized, failed: 0, summary });
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
