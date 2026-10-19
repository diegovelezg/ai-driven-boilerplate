// Ejecución manual del analyst (como scout-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/analyst-once.ts [windowDays]
import { runAnalyst } from "@/lib/analyst";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();

  const runId = await startRun(storeId, "analyst", "Analyst", 0);
  console.log(`run ${runId}`);
  await runAnalyst(runId, storeId, { windowDays: Number(process.argv[2] ?? 14) });
  console.log("fin (ver .data/analyst.log)");
}

main().catch((e) => {
  fail("ANALYST", e);
});
