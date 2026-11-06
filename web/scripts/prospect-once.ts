// Ejecución manual del prospector (como enrich-once.ts).
// Uso: npx tsx --env-file=.env.local scripts/prospect-once.ts [queries] [perQuery]
// Requiere: SearXNG en SEARXNG_URL + ICP en store_profiles + tenant B2B.
import { runProspect } from "@/lib/prospect";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();

  const runId = await startRun(storeId, "prospect", "Prospección", 1);
  console.log(`run ${runId}`);
  await runProspect(runId, storeId, {
    queries: Number(process.argv[2] ?? 3),
    perQuery: Number(process.argv[3] ?? 5),
    scope: null,
    marketLabel: null,
  });
  console.log("fin");
}

main().catch((e) => {
  fail("PROSPECT", e);
});
