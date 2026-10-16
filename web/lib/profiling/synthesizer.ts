// Synthesizer del set perfilador: confronta web + sector + datos y propone
// slots con evidencia y confianza por slot. No investiga (eso ya pasó);
// juzga con todo sobre la mesa.
import { completeProcessJson } from "./llm";
import { isKnownTaxonomyId, taxonomyPromptFragment } from "@/lib/taxonomy";
import type { InvestigateResult } from "@/lib/ai/investigate";
import type { VerticalBrief } from "@/lib/verticals";
import type { TenantStats } from "./analyst";
import type { BusinessModel, CatalogType, ArchetypeId } from "@/lib/store-profiles";

export interface SlotEvidence {
  slot: string;
  value: string;
  confidence: "alta" | "media" | "baja";
  source: "web" | "sector" | "datos" | "dicho";
}

export interface Synthesis {
  businessModel: BusinessModel | null;
  vertical: string | null;
  taxonomyId: string | null;
  buyerType: string | null;
  catalogType: CatalogType | null;
  archetype: ArchetypeId | null;
  cycleDays: number | null;
  companyRequired: boolean;
  confidence: "alta" | "media" | "baja";
  evidence: SlotEvidence[];
  /** Gaps que ni web+sector+datos cierran (van al interviewer). */
  questions: string[];
}

const SYSTEM = `Eres el sintetizador de perfiles de negocio. Recibes 4 evidencias y produces el perfil.
Responde SOLO JSON válido, sin markdown:
{"business_model": "b2c"|"b2b"|"hybrid"|null, "vertical": string|null, "taxonomy_id": string|null, "buyer_type": string|null, "catalog_type": "consumible"|"perecedero"|"moda_estacional"|"durable"|"servicio"|"digital"|"mixto"|null, "archetype": "b2c_consumible"|"b2c_moda"|"b2c_durable"|"b2b_recurrente"|"b2b_proyecto"|"hibrido"|null, "cycle_days": number|null, "company_required": boolean, "confidence": "alta"|"media"|"baja", "evidence": [{"slot": string, "value": string, "confidence": "alta"|"media"|"baja", "source": "web"|"sector"|"datos"|"dicho"}], "questions": string[]}
Reglas duras:
- business_model: "hybrid" exige evidencia POSITIVA de consumo personal (personas comprando para sí). Gmail masivo + dominios propios + ICP de negocios = b2b, nunca hybrid por defecto. La ausencia de company_name (campo vacío) no es evidencia de B2C.
- vertical: palabras del negocio, texto libre (máx 60). taxonomy_id: nodo Shopify si encaja, null si no.
- buyer_type: granularidad ("negocio pequeño anunciante", "consumidor final"...) o null.
- archetype coherente con business_model. cycle_days solo si hay evidencia (sector o datos); null antes que inventado.
- cycle_days: prefiere el intervalo_mediano de los datos si la cobertura es razonable (≥20% de compradores); si no, el ciclo típico del sector mapeado a días; null si nada lo sostiene. Cita la fuente en evidence.
- evidence: una entrada por slot con valor, cada una con su fuente real. Si dos fuentes discrepan, dilo en questions y baja confidence.
- questions: máx 3, solo lo que NADA cierra. Vacío si el perfil está completo.

${taxonomyPromptFragment()}`;

const VALID = {
  model: new Set(["b2c", "b2b", "hybrid"]),
  catalog: new Set(["consumible", "perecedero", "moda_estacional", "durable", "servicio", "digital", "mixto"]),
  archetype: new Set(["b2c_consumible", "b2c_moda", "b2c_durable", "b2b_recurrente", "b2b_proyecto", "hibrido"]),
  conf: new Set(["alta", "media", "baja"]),
  source: new Set(["web", "sector", "datos", "dicho"]),
};

export interface SynthesisInput {
  description: string;
  investigator: InvestigateResult;
  sectorBrief: VerticalBrief | null;
  sectorSources: Array<{ url: string; title: string }>;
  stats: TenantStats;
  icp: string | null;
}

/** Sintetiza el perfil desde las 4 evidencias. Lanza si el LLM falla. */
export async function synthesize(input: SynthesisInput): Promise<Synthesis> {
  const s = input.stats;
  const user = [
    `Lo dicho por el merchant:\n${input.description.slice(0, 1000)}`,
    `Web (${input.investigator.sources?.url ?? "sin web"}):\n${(input.investigator.webText ?? "(sin texto)").slice(0, 3000)}`,
    `Primera lectura: modelo=${input.investigator.businessModel} vertical=${input.investigator.vertical} buyer=${input.investigator.buyerType} ciclo=${input.investigator.cycleDays}`,
    input.sectorBrief
      ? `Brief del sector (confianza ${input.sectorBrief.confidence}): ${JSON.stringify(input.sectorBrief).slice(0, 2000)}`
      : "Brief del sector: no disponible.",
    `Datos de la tienda (${s.customers} customers, ${s.buyers} compradores): empresa=${Math.round(s.companyRate * 100)}%, dominio_propio=${Math.round(s.customDomainRate * 100)}%, repeat_2+compras=${Math.round(s.repeatRate * 100)}%, ticket_mediano=${s.ticketMedian ?? "?"} ${s.ticketCurrency ?? ""}, intervalo_mediano=${s.intervalMedian ?? "?"}d (informa el ${Math.round(s.intervalCoverage * 100)}% de compradores), top_dominios=${s.topDomains.map((t) => `${t.domain}(${t.customers})`).join(", ") || "—"}, enriquecidos=${s.enrichedSample.map((e) => `${e.domain}:${e.company ?? "?"}:${e.industry ?? "?"}`).join("; ") || "—"}`,
    input.icp ? `ICP declarado: ${input.icp.slice(0, 500)}` : "ICP: no declarado.",
  ].join("\n\n");
  const raw = await completeProcessJson("profiler_synthesize", SYSTEM, user);
  const p = JSON.parse(raw) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  /** Corte en borde de palabra (nada de "ocasio" a medias). */
  const cut = (v: string | null, n: number): string | null => {
    if (!v) return null;
    const t = v.trim();
    if (t.length <= n) return t;
    const sp = t.lastIndexOf(" ", n);
    return (sp > n * 0.5 ? t.slice(0, sp) : t.slice(0, n)).trim() || null;
  };
  const model = str(p.business_model);
  const catalog = str(p.catalog_type);
  const arch = str(p.archetype);
  const conf = str(p.confidence);
  const taxRaw = str(p.taxonomy_id);
  const cyc = p.cycle_days;
  const ev = Array.isArray(p.evidence)
    ? (p.evidence as Array<Record<string, unknown>>)
        .map((e) => {
          const slot = str(e.slot);
          const value = str(e.value);
          const c = str(e.confidence);
          const src = str(e.source);
          if (!slot || !value || !c || !src) return null;
          if (!VALID.conf.has(c) || !VALID.source.has(src)) return null;
          return { slot: slot.slice(0, 40), value: cut(value, 160) ?? value.slice(0, 160), confidence: c as SlotEvidence["confidence"], source: src as SlotEvidence["source"] };
        })
        .filter((e): e is SlotEvidence => e !== null)
        .slice(0, 10)
    : [];
  return {
    businessModel: model && VALID.model.has(model) ? (model as Synthesis["businessModel"]) : null,
    vertical: cut(str(p.vertical), 80),
    taxonomyId: taxRaw && isKnownTaxonomyId(taxRaw) ? taxRaw : null,
    buyerType: cut(str(p.buyer_type), 80),
    catalogType: catalog && VALID.catalog.has(catalog) ? (catalog as Synthesis["catalogType"]) : null,
    archetype: arch && VALID.archetype.has(arch) ? (arch as Synthesis["archetype"]) : null,
    cycleDays: typeof cyc === "number" && Number.isInteger(cyc) && cyc >= 1 && cyc <= 1095 ? cyc : null,
    companyRequired: p.company_required === true,
    confidence: conf && VALID.conf.has(conf) ? (conf as Synthesis["confidence"]) : "baja",
    evidence: ev,
    questions: Array.isArray(p.questions)
      ? p.questions.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 3)
      : [],
  };
}
