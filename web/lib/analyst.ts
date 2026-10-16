// Analyst (Medir, Fase A): ventana post-envío (~14d) → ¿volvió a comprar?
// → `revenue_attributed`, cierra la señal. Determinista, sin LLM:
// suma órdenes reales posteriores al envío; el proceso `analyst_measure`
// de llm_models.json queda reservado para atribución con contexto blando.
// Corre en background con `background_runs` kind `analyst`.
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";

const log = createLogger("analyst");

export interface AnalystOpts {
  /** Ventana de atribución en días tras el envío. */
  windowDays?: number;
}

export async function runAnalyst(
  runId: string,
  storeId: string,
  opts: AnalystOpts = {},
): Promise<void> {
  const { windowDays = 14 } = opts;
  const db = getSupabase();
  let measured = 0;
  let converted = 0;
  try {
    const { data, error } = await db
      .from("proposed_actions")
      .select("id,customer_id,signal_id,dispatched_at,customers(email)")
      .eq("store_id", storeId)
      .eq("status", "dispatched")
      .is("revenue_attributed", null)
      .not("dispatched_at", "is", null)
      .order("dispatched_at", { ascending: true })
      .limit(100);
    if (error) throw new Error(`Actions read: ${error.message}`);
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      customer_id: String(r.customer_id),
      signal_id: (r.signal_id as string | null) ?? null,
      dispatched_at: String(r.dispatched_at),
      email: String((r.customers as Record<string, unknown> | null)?.email ?? ""),
    }));
    log(`run ${runId} start pendientes=${rows.length} ventana=${windowDays}d`);

    for (const a of rows) {
      await advanceRun(runId, { processed: measured, failed: 0, current: a.email || a.id });
      try {
        const sent = new Date(a.dispatched_at);
        const windowEnd = new Date(sent.getTime() + windowDays * 86_400_000);
        const now = new Date();
        const { data: orders, error: oErr } = await db
          .from("orders")
          .select("total_amount,placed_at,status,payment_status,is_test")
          .eq("customer_id", a.customer_id)
          .gt("placed_at", sent.toISOString())
          .lte("placed_at", windowEnd.toISOString())
          .limit(50);
        if (oErr) throw new Error(`Orders read: ${oErr.message}`);
        const revenue = (((orders ?? []) as Array<Record<string, unknown>>)
          .filter((o) => {
            if (o.is_test === true) return false;
            const st = typeof o.status === "string" ? o.status.toLowerCase() : "";
            return !["cancelled", "canceled", "archived", "refunded"].includes(st);
          })
          .reduce((acc, o) => acc + Number(o.total_amount ?? 0), 0));
        const windowClosed = now > windowEnd;
        // Solo se escribe cuando hay conversión o la ventana ya cerró
        // (mientras tanto se sigue esperando, sin marcar).
        if (revenue > 0 || windowClosed) {
          const { error: upErr } = await db
            .from("proposed_actions")
            .update({ revenue_attributed: revenue })
            .eq("id", a.id);
          if (upErr) throw new Error(`Action update: ${upErr.message}`);
          if (a.signal_id) {
            await db
              .from("churn_signals")
              .update({ status: "closed", closed_at: new Date().toISOString() })
              .eq("id", a.signal_id);
          }
          measured += 1;
          if (revenue > 0) converted += 1;
          log(`run ${runId} ${a.email} → revenue=${revenue}${revenue > 0 ? " (convirtió)" : " (sin compra en ventana)"}`);
        } else {
          log(`run ${runId} ${a.email} → ventana abierta, se espera`);
        }
      } catch (e) {
        log(`run ${runId} ${a.email || a.id} ERROR ${e instanceof Error ? e.message : e}`);
      }
    }

    await advanceRun(runId, { processed: measured, failed: 0, current: null });
    const status: RunStatus = "done";
    const summary = `${measured} medidas · ${converted} conversiones`;
    await finishRun(runId, { status, processed: measured, failed: 0, summary });
    log(`run ${runId} ${status} ${summary}`);
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed: measured,
      failed: 0,
      error: e instanceof Error ? e.message : String(e),
    });
    log(`run ${runId} ERROR ${e instanceof Error ? e.message : e}`);
  }
}
