// Ejecución manual del scout (como enrich-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/scout-once.ts
import { runScout } from "@/lib/scout";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();

  const runId = await startRun(storeId, "scout", "Scout", 0);
  console.log(`run ${runId}`);
  await runScout(runId, storeId);
  console.log("fin (ver .data/scout.log y .data/adk.log)");
}

main().catch((e) => {
  fail("SCOUT", e);
});
