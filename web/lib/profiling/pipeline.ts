// Orquestador del set perfilador (aislado del loop de retención).
// investigator → (sector + analyst en paralelo) → synthesizer → critic.
// No escribe perfiles: devuelve la propuesta final + gaps para el humano/chat.
import { createProfilerLogger } from "./log";
import { getSupabase } from "@/lib/supabase";
import { investigateBusiness } from "@/lib/ai/investigate";
import { getVerticalProfile, researchVertical, saveVerticalProfile } from "@/lib/verticals";
import { tenantStats } from "./analyst";
import { synthesize, type Synthesis } from "./synthesizer";
import { critique, type Critique } from "./critic";

const baseLog = createProfilerLogger();

export interface ProfilerResult {
  synthesis: Synthesis;
  critic: Critique;
  sectorFromCache: boolean;
}

/** Aplica correcciones del critic a la síntesis (slots conocidos, con coerción). */
function applyCorrections(base: Synthesis, corrections: Critique["corrections"]): Synthesis {
  const next: Synthesis = { ...base, evidence: [...base.evidence] };
  for (const c of corrections) {
    next.evidence.push({ slot: c.slot, value: c.value, confidence: "media" as const, source: "datos" as const });
    switch (c.slot) {
      case "business_model":
        next.businessModel = "b2b";
        break;
      case "vertical":
        next.vertical = c.value.slice(0, 80);
        break;
      case "taxonomy_id":
        next.taxonomyId = c.value;
        break;
      case "buyer_type":
        next.buyerType = c.value.slice(0, 60);
        break;
      case "catalog_type":
        next.catalogType = c.value as Synthesis["catalogType"];
        break;
      case "archetype":
        next.archetype = (c.value === "b2b_proyecto" ? "b2b_proyecto" : "b2b_recurrente") as Synthesis["archetype"];
        break;
      case "cycle_days": {
        const n = Number(c.value);
        if (Number.isInteger(n) && n >= 1 && n <= 1095) next.cycleDays = n;
        break;
      }
      case "company_required":
        next.companyRequired = true;
        break;
    }
  }
  return next;
}

/**
 * Corre el set completo. Lanza si investigator/synthesizer/critic fallan
 * (error honesto); el sector sin web útil degrada a brief null, no a error.
 * `onStage` avisa cada etapa para progreso en vivo (cinta vía advanceRun).
 */
export async function runProfiler(
  storeId: string,
  description: string,
  onStage?: (step: { done: number; label: string }) => void,
): Promise<ProfilerResult> {
  const log = baseLog.child({ storeId });
  const t0 = Date.now();
  const investigator = await investigateBusiness(description, undefined, { storeId });
  log(`pipeline investigator vertical=${investigator.vertical} model=${investigator.businessModel} conf=${investigator.confidence}`);
  onStage?.({ done: 1, label: "Negocio investigado" });

  // NOTA: icp_description se extirpó en 20261122; se usa `description`
  // (columna viva) como contexto persistido del negocio, o null.
  const [sectorCached, stats, descRes] = await Promise.all([
    getVerticalProfile(investigator.taxonomyId, investigator.vertical ?? description.slice(0, 80)),
    tenantStats(storeId),
    getSupabase()
      .from("sys_store_profiles")
      .select("description")
      .eq("store_id", storeId)
      .maybeSingle(),
  ]);
  let sectorBrief = sectorCached?.brief ?? null;
  let sectorFromCache = !!sectorCached;
  const sectorSources = sectorCached?.sources.map((s) => ({ url: s.url, title: s.title })) ?? [];
  log(`pipeline sector ${sectorCached ? `CACHE conf=${sectorCached.confidence}` : "MISS"}`);
  if (!sectorBrief && investigator.vertical) {
    try {
      const research = await researchVertical(investigator.vertical, investigator.taxonomyId, { storeId });
      await saveVerticalProfile(investigator.taxonomyId, investigator.vertical, research).catch((e) => {
        log(`pipeline sector save fallo (${e instanceof Error ? e.message : e})`);
      });
      sectorBrief = research.brief;
      sectorFromCache = false;
      log(`pipeline sector researched conf=${research.brief.confidence} fuentes=${research.sources.length}`);
    } catch (e) {
      log(`pipeline sector sin brief (${e instanceof Error ? e.message : e}); se sigue sin prior`);
    }
  }
  const icp =
    (descRes.data as { description?: unknown } | null)?.description != null
      ? String((descRes.data as { description?: unknown }).description)
      : null;
  log(`pipeline stats buyers=${stats.buyers}/${stats.customers} ticket=${stats.ticketMedian} gaps->synthesize`);
  onStage?.({ done: 2, label: "Datos y sector cruzados" });

  const synthesis = await synthesize({
    description,
    investigator,
    sectorBrief,
    sectorSources,
    stats,
    icp,
    storeId,
  });
  log(`pipeline synthesis model=${synthesis.businessModel} arch=${synthesis.archetype} conf=${synthesis.confidence}`);
  onStage?.({ done: 3, label: "Perfil sintetizado" });

  const evidence = [
    `Web: ${(investigator.webText ?? "(sin texto)").slice(0, 1200)}`,
    sectorBrief ? `Sector: ${JSON.stringify(sectorBrief).slice(0, 800)}` : "Sector: sin brief.",
    `Datos: buyers=${stats.buyers}/${stats.customers} repeat=${Math.round(stats.repeatRate * 100)}% ticket=${stats.ticketMedian} intervalo_mediano=${stats.intervalMedian ?? "?"}d cobertura=${Math.round(stats.intervalCoverage * 100)}% top=${stats.topDomains.map((t) => t.domain).join(",")}`,
    icp ? `ICP: ${icp.slice(0, 200)}` : "ICP: no.",
  ].join("\n");
  const criticResult = await critique(synthesis, evidence, { storeId });
  const emptyReject = criticResult.verdict === "reject" && criticResult.corrections.length === 0;
  log(`pipeline critic verdict=${criticResult.verdict} corrections=${criticResult.corrections.length}${emptyReject ? " (reject sin correcciones: se mantiene síntesis)" : ""} (${Date.now() - t0}ms)`);

  const final =
    criticResult.verdict === "reject" && criticResult.corrections.length > 0
      ? { ...applyCorrections(synthesis, criticResult.corrections), confidence: "media" as const, questions: criticResult.questions.length > 0 ? criticResult.questions : synthesis.questions }
      : { ...synthesis, questions: criticResult.questions.length > 0 ? criticResult.questions : synthesis.questions };
  return { synthesis: final, critic: criticResult, sectorFromCache };
}
