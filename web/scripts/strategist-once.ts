// Ejecución manual del strategist (como scout-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/strategist-once.ts [limit]
import { runStrategist } from "@/lib/strategist";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();

  const runId = await startRun(storeId, "strategist", "Estratega", 0);
  console.log(`run ${runId}`);
  await runStrategist(runId, storeId, { limit: Number(process.argv[2] ?? 20) });
  console.log("fin (ver .data/strategist.log)");
}

main().catch((e) => {
  fail("STRATEGIST", e);
});
