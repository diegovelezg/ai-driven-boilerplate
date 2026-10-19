// Perfil del tenant + arquetipos de churn. Solo server-side (service_role).
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";

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
}

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

const FREE_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "aol.com", "proton.me", "protonmail.com", "uol.com.br",
]);

function rootDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim() || null;
}

export interface ProfileSignals {
  customers: number;
  companyRate: number;
  customDomainRate: number;
  repeatRate: number;
}

export async function getProfileSignals(storeId: string): Promise<(ProfileSignals & { truncated: boolean }) | null> {
  if (!isSupabaseConfigured()) return null;
  const db = getSupabase();
  const { count } = await db.from("customers").select("id", { count: "exact", head: true }).eq("store_id", storeId);
  const rows: Array<{ email: string; company_name: string | null; orders_count: number }> = [];
  let truncated = false;
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db
      .from("customers")
      .select("email,company_name,orders_count")
      .eq("store_id", storeId)
      .range(off, off + 999);
    if (error) throw new Error(`DB read: ${error.message}`);
    const page = (data ?? []) as Array<{ email: string; company_name: string | null; orders_count: number }>;
    rows.push(...page);
    if (page.length < 1000) break;
    if (rows.length >= 20000) {
      truncated = true;
      break;
    }
  }
  if (rows.length === 0) return { customers: count ?? 0, companyRate: 0, customDomainRate: 0, repeatRate: 0, truncated };
  let company = 0;
  let custom = 0;
  let repeat = 0;
  for (const r of rows) {
    if (r.company_name?.trim()) company += 1;
    const d = rootDomain(r.email ?? "");
    if (d && !FREE_DOMAINS.has(d)) custom += 1;
    if (Number(r.orders_count ?? 0) >= 2) repeat += 1;
  }
  return {
    customers: count ?? rows.length,
    companyRate: company / rows.length,
    customDomainRate: custom / rows.length,
    repeatRate: repeat / rows.length,
    truncated,
  };
}

export interface Suggestion {
  archetype: ArchetypeId;
  businessModel: BusinessModel;
  confidence: "alta" | "media" | "baja";
  reasons: string[];
}

/** Heurística mínima: distingue B2B (empresa/dominio propio) de B2C y
 *  propone arquetipo según recurrencia. Sin datos → b2c_consumible/auto. */
export function suggestArchetype(s: ProfileSignals | null): Suggestion {
  if (!s || s.customers < 5) {
    return {
      archetype: "b2c_consumible",
      businessModel: "b2c",
      confidence: "baja",
      reasons: ["Menos de 5 customers sincronizados: sugerencia por defecto."],
    };
  }
  const b2bScore = s.companyRate * 0.6 + s.customDomainRate * 0.4;
  const reasons = [
    `${Math.round(s.companyRate * 100)}% con empresa`,
    `${Math.round(s.customDomainRate * 100)}% con dominio propio`,
    `${Math.round(s.repeatRate * 100)}% con 2+ compras`,
  ];
  if (b2bScore > 0.5) {
    const archetype: ArchetypeId = s.repeatRate > 0.3 ? "b2b_recurrente" : "b2b_proyecto";
    return { archetype, businessModel: "b2b", confidence: b2bScore > 0.7 ? "alta" : "media", reasons };
  }
  if (s.companyRate > 0.15 || s.customDomainRate > 0.25) {
    return { archetype: "hibrido", businessModel: "hybrid", confidence: "media", reasons };
  }
  // B2C: sin mediana de intervalos aún (Fase 2); la recurrencia decide entre
  // consumible y durable como aproximación.
  const archetype: ArchetypeId = s.repeatRate > 0.25 ? "b2c_consumible" : "b2c_durable";
  return { archetype, businessModel: "b2c", confidence: "media", reasons };
}

function toProfile(storeId: string, r: Record<string, unknown>): StoreProfile {
  return {
    storeId,
    businessModel: (r.business_model as BusinessModel) ?? "b2c",
    verticalDetected: (r.vertical_detected as string) ?? null,
    taxonomyId: (r.taxonomy_id as string) ?? null,
    buyerType: (r.buyer_type as string) ?? null,
    industry: (r.industry as string) ?? null,
    catalogType: (r.catalog_type as CatalogType) ?? null,
    repurchaseCycleDays: (r.repurchase_cycle_days as number) ?? null,
    churnMultiplier: Number(r.churn_multiplier ?? 1.25),
    archetype: (r.archetype as ArchetypeId) ?? "b2c_consumible",
    archetypeSource: (r.archetype_source as StoreProfile["archetypeSource"]) ?? "auto",
    manualSlots: Array.isArray(r.manual_slots) ? (r.manual_slots as string[]) : [],
    companyRequired: Boolean(r.company_required),
    description: (r.description as string) ?? null,
    interpretationConfidence:
      (r.interpretation_confidence as StoreProfile["interpretationConfidence"]) ?? null,
    notes: (r.notes as string) ?? null,
  };
}

export async function getStoreProfile(storeId: string): Promise<StoreProfile | null> {
  if (!isSupabaseConfigured()) return null;
  const { data, error } = await getSupabase()
    .from("store_profiles")
    .select("*")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(`DB read: ${error.message}`);
  if (!data) return null;
  return toProfile(storeId, data as Record<string, unknown>);
}

export async function upsertStoreProfile(p: StoreProfile): Promise<void> {
  const { error } = await getSupabase().from("store_profiles").upsert(
    {
      store_id: p.storeId,
      business_model: p.businessModel,
      vertical_detected: p.verticalDetected,
      taxonomy_id: p.taxonomyId,
      buyer_type: p.buyerType,
      industry: p.industry,
      catalog_type: p.catalogType,
      repurchase_cycle_days: p.repurchaseCycleDays,
      churn_multiplier: p.churnMultiplier,
      archetype: p.archetype,
      archetype_source: p.archetypeSource,
      manual_slots: p.manualSlots ?? [],
      company_required: p.companyRequired,
      description: p.description,
      interpretation_confidence: p.interpretationConfidence,
      interpreted_at: p.interpretationConfidence ? new Date().toISOString() : null,
      notes: p.notes,
    },
    { onConflict: "store_id" },
  );
  if (error) throw new Error(`DB write: ${error.message}`);
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

/**
 * Actualiza SOLO la columna de un slot. Dos decisiones HITL en paralelo
 * sobre slots distintos no se pisan (Postgres serializa por fila y cada
 * update toca una columna distinta), a diferencia del upsert completo.
 */
export async function updateStoreProfileSlot(
  storeId: string,
  slot: StoreProfileSlot,
  value: string | null,
): Promise<void> {
  const { data, error } = await getSupabase()
    .from("store_profiles")
    .update({ ...profileSlotPatch(slot, value), updated_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .select("store_id");
  if (error) throw new Error(`DB write: ${error.message}`);
  if (!data || data.length === 0) throw new Error("DB write: perfil no encontrado.");
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

/**
 * Ciclo de recompra del tenant en días (dinámico por tienda): ciclo declarado
 * → default del arquetipo → null (sin ancla). Úsalo como techo absoluto para
 * que en bases dormidas un R relativo no corone "Campeones" de hace 200 días.
 */
export async function resolveTenantCycleDays(storeId: string): Promise<number | null> {
  const profile = await getStoreProfile(storeId).catch(() => null);
  if (!profile) return null;
  return (
    profile.repurchaseCycleDays ?? ARCHETYPES[profile.archetype]?.defaultCycleDays ?? null
  );
}

/** Moneda de la tienda (universo monetario: nunca mezclar PEN con MXN). */
export async function resolveShopCurrency(storeId: string): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const { data, error } = await getSupabase()
    .from("stores")
    .select("shop_currency")
    .eq("id", storeId)
    .maybeSingle();
  if (error) return null;
  return (data?.shop_currency as string | null) ?? null;
}
