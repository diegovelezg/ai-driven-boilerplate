// Smoke Fase A: researchVertical real (investiga → guarda → re-lee del cache).
// Uso: npx tsx --env-file=.env.local scripts/smoke-vertical.ts "publicidad en pantallas digitales de vía pública" [taxonomyId]
import { researchVertical, saveVerticalProfile, getVerticalProfile } from "@/lib/verticals";

async function main() {
  const vertical = process.argv[2] ?? "publicidad en pantallas digitales de vía pública";
  const taxonomyId = process.argv[3] ?? "gid://shopify/TaxonomyCategory/se";
  const t0 = Date.now();

  const cachedBefore = await getVerticalProfile(taxonomyId, vertical);
  console.log("cache antes:", cachedBefore ? `HIT (confianza ${cachedBefore.confidence})` : "MISS");

  const tR = Date.now();
  const research = await researchVertical(vertical, taxonomyId);
  console.log(`research (${Date.now() - tR}ms), ${research.sources.length} fuentes:`);
  for (const s of research.sources) console.log(`  - ${s.url} (${s.chars} chars)`);
  console.log("brief:", JSON.stringify(research.brief, null, 1));

  const tW = Date.now();
  await saveVerticalProfile(taxonomyId, vertical, research);
  console.log(`save (${Date.now() - tW}ms) OK`);

  const cachedAfter = await getVerticalProfile(taxonomyId, vertical);
  console.log(
    "cache después:",
    cachedAfter ? `HIT, ${cachedAfter.sources.length} fuentes` : "MISS (ERROR)",
  );
  if (!cachedAfter) process.exit(1);
  console.log(`\nTOTAL ${Date.now() - t0}ms — fin`);
}

main().catch((e) => {
  console.error("SMOKE FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
