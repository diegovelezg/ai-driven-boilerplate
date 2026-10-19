// Ejecución manual del clasificador (como prospect-once.ts).
// Uso: npx tsx --env-file=.env.local scripts/classify-once.ts [limit]
// Solo UPDATE customer_type cuando cambia y sin override manual. Sin LLM.
import { runClassify } from "@/lib/classify";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();

  const limit = Number(process.argv[2] ?? 0);
  const runId = await startRun(storeId, "classify", "Clasificación", limit || 1);
  console.log(`run ${runId}`);
  const counts = await runClassify(runId, storeId, limit);
  console.log("fin", JSON.stringify(counts));
}

main().catch((e) => {
  fail("CLASSIFY", e);
});
