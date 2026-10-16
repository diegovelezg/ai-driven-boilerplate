// Ejecución manual del scout (como enrich-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/scout-once.ts
import { readFileSync } from "node:fs";
import { getSupabase } from "@/lib/supabase";
import { runScout } from "@/lib/scout";
import { startRun } from "@/lib/background";

/** resolveStoreId inline: evita la cadena customers-db → sync (rompe tsx). */
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

  const runId = await startRun(storeId, "scout", "Scout", 0);
  console.log(`run ${runId}`);
  await runScout(runId, storeId);
  console.log("fin (ver .data/scout.log y .data/adk.log)");
}

main().catch((e) => {
  console.error("SCOUT FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
