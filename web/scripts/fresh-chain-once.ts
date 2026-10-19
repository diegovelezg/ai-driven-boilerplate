// Run fresco total post-limpieza: retention → scout → strategist → copywriter.
// La cadena morning se salta sola si hoy ya marcó done; este script la corre
// explícita sin borrar historial (cada paso abre su propia corrida).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/fresh-chain-once.ts [copyLimit]
import { runRetentionModel } from "@/lib/retention";
import { runScout } from "@/lib/scout";
import { runStrategist } from "@/lib/strategist";
import { runCopywriter } from "@/lib/copywriter";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();
  const copyLimit = Number(process.argv[2] ?? 10);

  const retention = await runRetentionModel(storeId, new Date());
  console.log(`retention predicted=${retention.predicted} actuar=${retention.actuar} vigilar=${retention.vigilar}`);
  const scoutRun = await startRun(storeId, "scout", "Scout", 0);
  await runScout(scoutRun, storeId);
  console.log(`scout fin (run ${scoutRun}, ver .data/scout.log)`);
  const stratRun = await startRun(storeId, "strategist", "Estratega", 0);
  await runStrategist(stratRun, storeId);
  console.log(`strategist fin (run ${stratRun}, ver .data/strategist.log)`);
  const copyRun = await startRun(storeId, "copywriter", "Copywriter", 0);
  await runCopywriter(copyRun, storeId, { limit: copyLimit });
  console.log(`copywriter fin (run ${copyRun}, ver .data/copywriter.log)`);
  console.log("fresh-chain done");
}

main().catch((e) => {
  fail("FRESH-CHAIN", e);
});
