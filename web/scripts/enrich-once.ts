// Ejecución manual del enriquecimiento (como sync-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/enrich-once.ts [limit]
import { readFileSync } from "node:fs";
import { getSupabase } from "@/lib/supabase";
import { pendingDomains, runEnrichment } from "@/lib/enrich";
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
  const limit = Number(process.argv[2] ?? 3);

  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) throw new Error("Tienda sin sincronizar en Supabase.");

  const pending = await pendingDomains(storeId);
  console.log(`pendientes: ${pending.length}`);
  console.log(`muestra: ${pending.slice(0, 5).join(", ")}`);
  if (pending.length === 0) return;

  const batch = pending.slice(0, limit);
  const runId = await startRun(storeId, "enrichment", "Enriquecimiento", batch.length);
  console.log(`run ${runId} · ${batch.length} dominios`);
  await runEnrichment(runId, batch);
  console.log("fin");
}

main().catch((e) => {
  console.error("ENRICH FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
