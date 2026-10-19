// Ejecución manual del enriquecimiento (como sync-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/enrich-once.ts [limit]
import { pendingDomains, runEnrichment } from "@/lib/enrich";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();
  const limit = Number(process.argv[2] ?? 3);

  const pending = await pendingDomains(storeId);
  console.log(`pendientes: ${pending.length}`);
  console.log(`muestra: ${pending.slice(0, 5).join(", ")}`);
  if (pending.length === 0) return;

  const batch = pending.slice(0, limit);
  const runId = await startRun(storeId, "enrichment", "Enriquecimiento", batch.length);
  console.log(`run ${runId} · ${batch.length} dominios`);
  await runEnrichment(runId, batch, { storeId });
  const { invalidatePendingCache } = await import("@/lib/enrich");
  invalidatePendingCache(storeId);
  console.log("fin");
}

main().catch((e) => {
  fail("ENRICH", e);
});
