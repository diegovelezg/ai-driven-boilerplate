// Strategist (Decidir, Fase A): lee señales `open` → prioriza
// (valor × probabilidad) → `prioritized` + objetivo
// (`winback`|`nurture`|`vip_care`). Determinista, sin LLM:
// auditable y barato; el proceso `strategist_plan` de llm_models.json queda
// reservado para priorización con contexto blando futuro.
// Corre en background con `background_runs` kind `strategist`.
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";

const log = createLogger("strategist");

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
    const { data, error } = await db
      .from("churn_signals")
      .select("id,customer_id,score,reason,customers(email,first_name,last_name,orders_count,total_spent)")
      .eq("store_id", storeId)
      .eq("status", "open")
      .order("score", { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) throw new Error(`Signals read: ${error.message}`);
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const c = (r.customers ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id),
        customer_id: String(r.customer_id),
        score: r.score == null ? null : Number(r.score),
        reason: (r.reason as string | null) ?? null,
        email: String(c.email ?? ""),
        first_name: (c.first_name as string | null) ?? null,
        last_name: (c.last_name as string | null) ?? null,
        orders_count: Number(c.orders_count ?? 0),
        total_spent: Number(c.total_spent ?? 0),
      } satisfies OpenSignal;
    });
    // Valor × probabilidad: score primero, gasto como desempate.
    rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.total_spent - a.total_spent);
    const spends = [...rows.map((r) => r.total_spent)].sort((a, b) => a - b);
    const vipSpend = spends.length > 0 ? spends[Math.floor(spends.length * 0.8)] : 0;
    log(`run ${runId} start abiertas=${rows.length} limite=${limit} umbral_vip=${vipSpend}`);

    const batch = rows.slice(0, Math.max(0, limit));
    let i = 0;
    for (const s of batch) {
      i += 1;
      await advanceRun(runId, { processed: prioritized, failed: 0, current: s.email || s.customer_id });
      const kind = objective(s, vipSpend);
      const { error: upErr } = await db
        .from("churn_signals")
        .update({ status: "prioritized", kind })
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
