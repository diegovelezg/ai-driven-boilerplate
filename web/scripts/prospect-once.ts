// Ejecución manual del prospector (como enrich-once.ts).
// Uso: npx tsx --env-file=.env.local scripts/prospect-once.ts [queries] [perQuery]
// Requiere: SearXNG en SEARXNG_URL (default http://localhost:8888) + ICP en store_profiles.
import { readFileSync } from "node:fs";
import { getSupabase } from "@/lib/supabase";
import { runProspect } from "@/lib/prospect";
import { startRun } from "@/lib/background";

/** resolveStoreId inline: evita la cadena customers-db → sync → server-only (rompe tsx). */
async function resolveStoreId(medusaUrl: string): Promise<string | null> {
  const normalized = medusaUrl.trim().toLowerCase().replace(/\/+$/, "");
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

  const runId = await startRun(storeId, "prospect", "Prospección", 1);
  console.log(`run ${runId}`);
  await runProspect(runId, storeId, {
    queries: Number(process.argv[2] ?? 2),
    perQuery: Number(process.argv[3] ?? 5),
  });
  console.log("fin");
}

main().catch((e) => {
  console.error("PROSPECT FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
