// Clasificador B2B/B2C por dominio (worker post-sync). Regla del blueprint:
// webmail + sin empresa → B2C; dominio propio/institucional (o empresa declarada
// con ID fiscal implícito) → B2B. Webmail CON empresa = ambiguo: no se toca.
// Nunca pisa overrides manuales (manual_edits.customer_type). Sin LLM: la regla
// es determinista; el gate LLM vive en el enricher por dominio.
import { getSupabase } from "@/lib/supabase";
import { classifyDomain, domainFromEmail } from "@/lib/domains";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";

export interface ClassifyCounts {
  b2b: number;
  b2c: number;
  untouched: number;
}

/** Clasifica la tienda por páginas; actualiza solo customer_type cuando cambia. */
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
        .select("id,email,company_name,customer_type,manual_edits")
        .eq("store_id", storeId)
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
          const overrides = (r.manual_edits as Record<string, unknown> | null) ?? {};
          if (typeof overrides.customer_type === "string" && overrides.customer_type.trim()) {
            counts.untouched += 1; // override manual: no tocar
            continue;
          }
          const domain = domainFromEmail(String(r.email ?? ""));
          const cls = classifyDomain(domain);
          const company = String(r.company_name ?? "").trim();
          let next: string | null = null;
          if (cls.type === "webmail" && !company) next = "B2C";
          else if (cls.type === "business" || cls.type === "institutional") next = "B2B";
          if (!next || next === String(r.customer_type ?? "B2C")) {
            counts.untouched += 1;
            continue;
          }
          const { error: upErr } = await db.from("customers").update({ customer_type: next }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          processed += 1;
          if (next === "B2B") counts.b2b += 1;
          else counts.b2c += 1;
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
      summary: `${processed} clasificados (B2B ${counts.b2b} · B2C ${counts.b2c}) · ${counts.untouched} intactos`,
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
