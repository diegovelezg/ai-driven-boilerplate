// Ejecución manual del dispatcher (como scout-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/dispatcher-once.ts
// Sin RETAIN_DISPATCH_STUB=1 no envía nada (bloqueado: sin proveedor).
import { runDispatcher } from "@/lib/dispatcher";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();

  const runId = await startRun(storeId, "dispatcher", "Dispatcher", 0);
  console.log(`run ${runId}`);
  await runDispatcher(runId, storeId);
  console.log("fin (ver .data/dispatcher.log)");
}

main().catch((e) => {
  fail("DISPATCHER", e);
});
