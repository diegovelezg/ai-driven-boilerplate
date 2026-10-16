// Ejecución manual del strategist (como scout-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/strategist-once.ts [limit]
import { readFileSync } from "node:fs";
import { getSupabase } from "@/lib/supabase";
import { runStrategist } from "@/lib/strategist";
import { startRun } from "@/lib/background";

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

  const runId = await startRun(storeId, "strategist", "Estratega", 0);
  console.log(`run ${runId}`);
  await runStrategist(runId, storeId, { limit: Number(process.argv[2] ?? 20) });
  console.log("fin (ver .data/strategist.log)");
}

main().catch((e) => {
  console.error("STRATEGIST FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
