// Definiciones puras del perfil del tenant + arquetipos de churn.
// Módulo SIN imports server: lo importan Client Components
// (profile-proposals, tenant-profile-form), tests tsx y código servidor.
// Todo lo que toque Supabase vive en `lib/store-profiles.ts` (solo servidor).

export type BusinessModel = "b2c" | "b2b" | "hybrid";
export type CatalogType =
  | "consumible"
  | "perecedero"
  | "moda_estacional"
  | "durable"
  | "servicio"
  | "digital"
  | "mixto";
export type ArchetypeId =
  | "b2c_consumible"
  | "b2c_moda"
  | "b2c_durable"
  | "b2b_recurrente"
  | "b2b_proyecto"
  | "hibrido";

export interface ArchetypeDef {
  id: ArchetypeId;
  label: string;
  description: string;
  businessModel: BusinessModel;
  defaultCycleDays: number;
  defaultMultiplier: number;
  companyRequired: boolean;
}

export const ARCHETYPES: Record<ArchetypeId, ArchetypeDef> = {
  b2c_consumible: {
    id: "b2c_consumible",
    label: "B2C · Consumible recurrente",
    description: "Café, cosmética, pet-food. Recompra 15–45 días, churn = ciclo × 1.25.",
    businessModel: "b2c",
    defaultCycleDays: 30,
    defaultMultiplier: 1.25,
    companyRequired: false,
  },
  b2c_moda: {
    id: "b2c_moda",
    label: "B2C · Moda / estacional",
    description: "Ropa, calzado. Ciclo 90–180 días por temporada; intervalo puro no basta.",
    businessModel: "b2c",
    defaultCycleDays: 120,
    defaultMultiplier: 2.0,
    companyRequired: false,
  },
  b2c_durable: {
    id: "b2c_durable",
    label: "B2C · Durable / ticket alto",
    description: "Muebles, electrónica. F=1 es normal; churn 180–365 días.",
    businessModel: "b2c",
    defaultCycleDays: 270,
    defaultMultiplier: 1.5,
    companyRequired: false,
  },
  b2b_recurrente: {
    id: "b2b_recurrente",
    label: "B2B · Distribuidor recurrente",
    description: "Reposición 30–60 días, empresa obligatoria, alerta temprana × 1.1.",
    businessModel: "b2b",
    defaultCycleDays: 45,
    defaultMultiplier: 1.1,
    companyRequired: true,
  },
  b2b_proyecto: {
    id: "b2b_proyecto",
    label: "B2B · Corporativo / proyecto",
    description: "Servicios, equipamiento. Compra esporádica; churn por inactividad 90–180 días.",
    businessModel: "b2b",
    defaultCycleDays: 135,
    defaultMultiplier: 1.5,
    companyRequired: true,
  },
  hibrido: {
    id: "hibrido",
    label: "Híbrido B2C + B2B",
    description: "Mezcla ambos; segmentar por customer_type y aplicar regla por lado.",
    businessModel: "hybrid",
    defaultCycleDays: 60,
    defaultMultiplier: 1.25,
    companyRequired: false,
  },
};

export interface StoreProfile {
  storeId: string;
  businessModel: BusinessModel;
  /** Vertical con las palabras del agente (verdad primaria). */
  verticalDetected: string | null;
  /** Nodo Shopify Standard Product Taxonomy (null = sin mapeo honesto). */
  taxonomyId: string | null;
  /** Granularidad del comprador deducida por el perfilador. */
  buyerType: string | null;
  industry: string | null;
  catalogType: CatalogType | null;
  repurchaseCycleDays: number | null;
  churnMultiplier: number;
  archetype: ArchetypeId;
  archetypeSource: "manual" | "sugerido" | "auto";
  /** Slots fijados a mano (vigilante #6): nunca se proponen cambios sobre ellos. */
  manualSlots: string[];
  companyRequired: boolean;
  /** Descripción libre del negocio (entrada orgánica primaria). */
  description: string | null;
  interpretationConfidence: "alta" | "media" | "baja" | null;
  notes: string | null;
  /** Corte p para "seguimiento cercano" (issue #21 Paso 1). Null = default. */
  closeWatchP?: number | null;
  /** Cortes de banda_p por tenant (issue #21 Paso 5). Null = default arquetipo. */
  bandHigh?: number | null;
  bandLow?: number | null;
}

/** Defaults de banda por arquetipo (issue #21 Paso 5): hoy todos reproducen
 *  v2 (0.6/0.15). La forma es global y versionada; los valores son por tenant
 *  con fallback al default del arquetipo (shrinkage, no fitted global). */
export const BAND_CUTS_BY_ARCHETYPE: Record<ArchetypeId, { high: number; low: number }> = {
  b2c_consumible: { high: 0.6, low: 0.15 },
  b2c_moda: { high: 0.6, low: 0.15 },
  b2c_durable: { high: 0.6, low: 0.15 },
  b2b_recurrente: { high: 0.6, low: 0.15 },
  b2b_proyecto: { high: 0.6, low: 0.15 },
  hibrido: { high: 0.6, low: 0.15 },
};

export const INDUSTRIES = [
  "alimentos",
  "moda",
  "belleza",
  "hogar",
  "electronica",
  "salud",
  "mascotas",
  "servicios",
  "distribucion",
  "otro",
] as const;

export interface ProfileSignals {
  customers: number;
  companyRate: number;
  customDomainRate: number;
  repeatRate: number;
}

export interface Suggestion {
  archetype: ArchetypeId;
  businessModel: BusinessModel;
  confidence: "alta" | "media" | "baja";
  reasons: string[];
  /** Versión de la regla (auditable: cambia si cambian umbrales/pesos). */
  ruleVersion: string;
}

/** Versión de la heurística B2B/B2C. Sube cuando cambia cualquier umbral/peso. */
export const ARCHETYPE_RULE_VERSION = "v1:w0.6-0.4/b2b0.5-high0.7/hyb0.15-0.25/rep0.3-0.25";

/** Umbrales de la heurística (un solo lugar, testeable). */
export const ARCHETYPE_THRESHOLDS = {
  companyW: 0.6,
  domainW: 0.4,
  b2bScore: 0.5,
  b2bHigh: 0.7,
  hybridCompany: 0.15,
  hybridDomain: 0.25,
  b2bRepeat: 0.3,
  b2cRepeat: 0.25,
} as const;

/** Heurística mínima: distingue B2B (empresa/dominio propio) de B2C y
 *  propone arquetipo según recurrencia. Sin datos → b2c_consumible/auto.
 *  Regla versionada en ARCHETYPE_RULE_VERSION. */
export function suggestArchetype(s: ProfileSignals | null): Suggestion {
  if (!s || s.customers < 5) {
    return {
      archetype: "b2c_consumible",
      businessModel: "b2c",
      confidence: "baja",
      reasons: ["Menos de 5 customers sincronizados: sugerencia por defecto."],
      ruleVersion: ARCHETYPE_RULE_VERSION,
    };
  }
  const t = ARCHETYPE_THRESHOLDS;
  const b2bScore = s.companyRate * t.companyW + s.customDomainRate * t.domainW;
  const reasons = [
    `${Math.round(s.companyRate * 100)}% con empresa`,
    `${Math.round(s.customDomainRate * 100)}% con dominio propio`,
    `${Math.round(s.repeatRate * 100)}% con 2+ compras`,
  ];
  if (b2bScore > t.b2bScore) {
    const archetype: ArchetypeId = s.repeatRate > t.b2bRepeat ? "b2b_recurrente" : "b2b_proyecto";
    return { archetype, businessModel: "b2b", confidence: b2bScore > t.b2bHigh ? "alta" : "media", reasons, ruleVersion: ARCHETYPE_RULE_VERSION };
  }
  if (s.companyRate > t.hybridCompany || s.customDomainRate > t.hybridDomain) {
    return { archetype: "hibrido", businessModel: "hybrid", confidence: "media", reasons, ruleVersion: ARCHETYPE_RULE_VERSION };
  }
  // B2C: sin mediana de intervalos aún (Fase 2); la recurrencia decide entre
  // consumible y durable como aproximación.
  const archetype: ArchetypeId = s.repeatRate > t.b2cRepeat ? "b2c_consumible" : "b2c_durable";
  return { archetype, businessModel: "b2c", confidence: "media", reasons, ruleVersion: ARCHETYPE_RULE_VERSION };
}

/** Slots del perfil que el vigilante puede proponer (columnas 1:1). */
export type StoreProfileSlot =
  | "archetype"
  | "repurchase_cycle_days"
  | "taxonomy_id"
  | "buyer_type";

/** Patch de UNA columna para un slot (puro). Valor serializado como en los deltas. */
export function profileSlotPatch(
  slot: StoreProfileSlot,
  value: string | null,
): Record<string, unknown> {
  switch (slot) {
    case "archetype":
      return { archetype: value };
    case "repurchase_cycle_days":
      return { repurchase_cycle_days: value === null ? null : Number(value) };
    case "taxonomy_id":
      return { taxonomy_id: value };
    case "buyer_type":
      return { buyer_type: value };
  }
}

export interface ManualSlotsInput {
  archetypeSource: "manual" | "sugerido";
  archetype: ArchetypeId;
  cycleDays: number | null;
  taxonomyId: string | null;
  buyerType: string | null;
  /** Perfil vigente antes de este guardado (para no perder protecciones). */
  existing: StoreProfile | null;
}

/**
 * Slots protegidos tras un guardado del form (puro). Con fuente `manual`
 * se protege todo lo fijado; con `sugerido` se conserva la protección de
 * los slots manuales previos cuyo valor no cambió en este guardado.
 */
export function resolveManualSlots(input: ManualSlotsInput): string[] {
  if (input.archetypeSource === "manual") {
    return [
      "archetype",
      ...(input.cycleDays !== null ? ["repurchase_cycle_days"] : []),
      ...(input.taxonomyId ? ["taxonomy_id"] : []),
      ...(input.buyerType ? ["buyer_type"] : []),
    ];
  }
  const prev = input.existing;
  if (!prev) return [];
  const same: Record<string, boolean> = {
    archetype: prev.archetype === input.archetype,
    repurchase_cycle_days: prev.repurchaseCycleDays === input.cycleDays,
    taxonomy_id: prev.taxonomyId === input.taxonomyId,
    buyer_type: prev.buyerType === input.buyerType,
  };
  return (prev.manualSlots ?? []).filter((s) => same[s]);
}
