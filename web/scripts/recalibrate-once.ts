// Vigilante de perfil (#6) en corrida única, como profiler-once.ts.
// Uso: npx tsx --env-file=.env.local scripts/recalibrate-once.ts [--dry-run]
// Sin --dry-run: snapshot + (solo con drift) set perfilador + propuesta HITL
// en Settings. Nunca aplica cambios al perfil por sí solo.
import { runRecalibration } from "@/lib/profile-recalibrate/service";
import { fail, loadServiceStore } from "./lib/run-once";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { storeId } = await loadServiceStore();

  const outcome = await runRecalibration(storeId, { source: "script", dryRun });
  console.log(`recalibrate status=${outcome.status}: ${outcome.reason}`);
  for (const t of outcome.triggers) {
    console.log(`  trigger ${t.kind}${t.requiresProfiler ? "" : " (solo avisa)"}: ${t.detail}`);
  }
  for (const d of outcome.deltas ?? []) {
    console.log(`  delta ${d.slot}: ${d.de ?? "auto"} → ${d.a ?? "auto"} (${d.confianza}) ${d.evidencia}`);
  }
}

main().catch((e) => {
  fail("RECALIBRATE", e);
});
