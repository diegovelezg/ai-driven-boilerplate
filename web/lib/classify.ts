// Sistema B2B-only: todo customer es empresa.
// runClassify normaliza a 'B2B' cualquier fila legacy (incluye overrides
// manuales B2C heredados). Se mantiene la firma/counts por compat con el
// worker (b2c siempre 0).
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { formatNumber } from "@/lib/format";

export interface ClassifyCounts {
  b2b: number;
  b2c: number;
  untouched: number;
}

/** Normaliza la tienda a B2B por páginas; actualiza solo customer_type cuando cambia. */
export async function runClassify(runId: string, storeId: string, limit = 0): Promise<ClassifyCounts> {
  const db = getSupabase();
  const counts: ClassifyCounts = { b2b: 0, b2c: 0, untouched: 0 };
  let processed = 0;
  let failed = 0;
  let done = 0;

  try {
    for (let from = 0; ; from += 500) {
      const { data, error } = await db
        .from("customers")
        .select("id,email,customer_type")
        .eq("store_id", storeId)
        .order("id", { ascending: true })
        .range(from, from + 499);
      if (error) throw new Error(`Customers read: ${error.message}`);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;

      for (const r of rows) {
        if (limit > 0 && done >= limit) break;
        done += 1;
        const id = String(r.id);
        await advanceRun(runId, { processed, failed, current: String(r.email ?? id) });
        try {
          if (String(r.customer_type ?? "B2B") === "B2B") {
            counts.untouched += 1;
            continue;
          }
          const { error: upErr } = await db.from("customers").update({ customer_type: "B2B" }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          processed += 1;
          counts.b2b += 1;
        } catch {
          failed += 1;
        }
      }
      if (rows.length < 500 || (limit > 0 && done >= limit)) break;
    }
    const status: RunStatus = processed === 0 && failed > 0 ? "error" : "done";
    await finishRun(runId, {
      status,
      processed,
      failed,
      summary: `${formatNumber(processed)} normalizados a B2B · ${formatNumber(counts.untouched)} intactos`,
    });
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed,
      failed,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return counts;
}
