// Ejecución manual del clasificador (como prospect-once.ts).
// Uso: npx tsx --env-file=.env.local scripts/classify-once.ts [limit]
// Solo UPDATE customer_type cuando cambia y sin override manual. Sin LLM.
import { readFileSync } from "node:fs";
import { getSupabase } from "@/lib/supabase";
import { runClassify } from "@/lib/classify";
import { startRun } from "@/lib/background";

/** resolveStoreId inline: evita la cadena customers-db → sync → server-only (rompe tsx). */
async function resolveStoreId(medusaUrl: string): Promise<string | null> {
  const normalized = medusaUrl.trim().replace(/\/+$/, "").toLowerCase();
  const { data } = await getSupabase()
    .from("stores")
    .select("id")
    .eq("platform", "medusa")
    .eq("shop_url", normalized)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

async function main() {
  const conn = JSON.parse(readFileSync(".data/connections.json", "utf-8"));
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) throw new Error("Tienda sin sincronizar en Supabase.");

  const limit = Number(process.argv[2] ?? 0);
  const runId = await startRun(storeId, "classify", "Clasificación", limit || 1);
  console.log(`run ${runId}`);
  const counts = await runClassify(runId, storeId, limit);
  console.log("fin", JSON.stringify(counts));
}

main().catch((e) => {
  console.error("CLASSIFY FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
