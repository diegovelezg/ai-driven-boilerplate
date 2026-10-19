// Ejecución manual del copywriter (como scout-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/copywriter-once.ts [limit]
// Requiere: OPENAI_API_KEY o DEEPSEEK_API_KEY (proceso proposer_draft).
import { runCopywriter } from "@/lib/copywriter";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();

  const runId = await startRun(storeId, "copywriter", "Copywriter", 0);
  console.log(`run ${runId}`);
  await runCopywriter(runId, storeId, { limit: Number(process.argv[2] ?? 10) });
  console.log("fin (ver .data/copywriter.log)");
}

main().catch((e) => {
  fail("COPYWRITER", e);
});
