// Ejecución manual del perfilador (como scout-once.ts).
// Uso: npx tsx --env-file=.env.local scripts/profiler-once.ts "descripción del negocio"
// Persiste la síntesis en store_profiles (archetypeSource=auto).
// Las correcciones del critic con arquetipo fuera del catálogo se descartan con log.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runProfiler } from "@/lib/profiling/pipeline";
import { ARCHETYPES, upsertStoreProfile, type ArchetypeId } from "@/lib/store-profiles";

async function main() {
  const description = process.argv[2];
  if (!description) throw new Error("Falta la descripción del negocio como argumento.");
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const medusaUrl = String(
    JSON.parse(readFileSync(".data/connections.json", "utf-8")).medusaUrl,
  ).replace(/\/+$/, "");
  const { data: store } = await db.from("stores").select("id").eq("shop_url", medusaUrl).maybeSingle();
  if (!store) throw new Error("Sin store para esta conexión.");
  const storeId = store.id as string;

  const { synthesis: s, critic } = await runProfiler(storeId, description);
  let archetype = s.archetype;
  for (const c of critic.corrections ?? []) {
    if (c.slot === "archetype") {
      if (c.value in ARCHETYPES) archetype = c.value as ArchetypeId;
      else console.warn(`[profiler] corrección del critic descartada (arquetipo inválido): ${c.value}`);
    }
  }
  if (!archetype || !s.businessModel) {
    throw new Error("Síntesis incompleta: sin arquetipo o modelo de negocio.");
  }
  await upsertStoreProfile({
    storeId,
    businessModel: s.businessModel,
    verticalDetected: s.vertical,
    taxonomyId: s.taxonomyId,
    buyerType: s.buyerType,
    industry: null,
    catalogType: s.catalogType,
    repurchaseCycleDays: s.cycleDays,
    churnMultiplier: ARCHETYPES[archetype].defaultMultiplier,
    archetype,
    archetypeSource: "auto",
    manualSlots: [],
    companyRequired: s.companyRequired,
    description,
    interpretationConfidence: s.confidence,
    notes:
      critic.verdict === "reject"
        ? `critic reject: ${(critic.reasons ?? []).join(" | ")}`.slice(0, 500)
        : null,
  });
  console.log(
    `perfil guardado: ${s.businessModel}/${archetype} ciclo=${s.cycleDays ?? "auto"} conf=${s.confidence} critic=${critic.verdict}`,
  );
}

main().catch((e) => {
  console.error("PROFILER FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
