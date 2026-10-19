// Smoke del set perfilador (pipeline completo, sin escribir perfiles).
// Uso: npx tsx --env-file=.env.local scripts/smoke-profiler.ts "somos tupantalla.com"
// Valida: investigator → sector(cache) + analyst → synthesizer → critic.
import { runProfiler } from "@/lib/profiling/pipeline";
import { loadServiceStore } from "./lib/run-once";

async function main() {
  const description = process.argv[2] ?? "somos tupantalla.com";
  const { storeId } = await loadServiceStore();
  const t0 = Date.now();
  const { synthesis: s, critic, sectorFromCache } = await runProfiler(storeId, description);
  console.log(`sector: ${sectorFromCache ? "CACHE" : "investigado"}`);
  console.log("SYNTHESIS:", JSON.stringify({
    businessModel: s.businessModel,
    vertical: s.vertical,
    taxonomyId: s.taxonomyId,
    buyerType: s.buyerType,
    catalogType: s.catalogType,
    archetype: s.archetype,
    cycleDays: s.cycleDays,
    companyRequired: s.companyRequired,
    confidence: s.confidence,
  }, null, 1));
  console.log("EVIDENCE:", JSON.stringify(s.evidence, null, 1));
  console.log("CRITIC:", JSON.stringify(critic, null, 1));
  console.log(`\nTOTAL ${Date.now() - t0}ms — fin`);
}

main().catch((e) => {
  console.error("SMOKE FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
