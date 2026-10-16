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
  industry: string | null;
  catalogType: CatalogType | null;
  repurchaseCycleDays: number | null;
  churnMultiplier: number;
  archetype: ArchetypeId;
  archetypeSource: "manual" | "sugerido" | "auto";
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

export async function getProfileSignals(storeId: string): Promise<ProfileSignals | null> {
  if (!isSupabaseConfigured()) return null;
  const db = getSupabase();
  const { data, error } = await db
    .from("customers")
    .select("email,company_name,orders_count")
    .eq("store_id", storeId)
    .limit(2000);
  if (error) throw new Error(`DB read: ${error.message}`);
  const rows = (data ?? []) as Array<{ email: string; company_name: string | null; orders_count: number }>;
  if (rows.length === 0) return { customers: 0, companyRate: 0, customDomainRate: 0, repeatRate: 0 };
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
    customers: rows.length,
    companyRate: company / rows.length,
    customDomainRate: custom / rows.length,
    repeatRate: repeat / rows.length,
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
    industry: (r.industry as string) ?? null,
    catalogType: (r.catalog_type as CatalogType) ?? null,
    repurchaseCycleDays: (r.repurchase_cycle_days as number) ?? null,
    churnMultiplier: Number(r.churn_multiplier ?? 1.25),
    archetype: (r.archetype as ArchetypeId) ?? "b2c_consumible",
    archetypeSource: (r.archetype_source as StoreProfile["archetypeSource"]) ?? "auto",
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
      industry: p.industry,
      catalog_type: p.catalogType,
      repurchase_cycle_days: p.repurchaseCycleDays,
      churn_multiplier: p.churnMultiplier,
      archetype: p.archetype,
      archetype_source: p.archetypeSource,
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
