// Perfil del tenant: lecturas/escrituras a Supabase (solo servidor:
// usa service_role vía @/lib/supabase, nunca importar este módulo en
// Client Components). Lo puro (tipos, ARCHETYPES, heurísticas de slots)
// vive en `lib/store-profile-defs.ts`, apto para clientes y tests.
// Este módulo re-exporta lo puro por compatibilidad: el código servidor
// puede seguir importando de `@/lib/store-profiles`.
// (Sin `import "server-only"` a propósito: los tests `tsx --test` corren en
// node plano y el paquete lanza fuera de React Server Components.)
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { CLOSE_WATCH_DEFAULT_P } from "@/lib/customer-predictions";
import { domainFromEmail, isCustomDomain } from "@/lib/domains";

export * from "./store-profile-defs";
import {
  ARCHETYPES,
  BAND_CUTS_BY_ARCHETYPE,
  profileSlotPatch,
  type ArchetypeId,
  type BusinessModel,
  type CatalogType,
  type ProfileSignals,
  type StoreProfile,
  type StoreProfileSlot,
} from "./store-profile-defs";

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
      .order("id", { ascending: true })
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
    const d = domainFromEmail(r.email ?? "");
    if (isCustomDomain(d)) custom += 1;
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
    closeWatchP:
      r.close_watch_p == null || !Number.isFinite(Number(r.close_watch_p))
        ? null
        : Number(r.close_watch_p),
    bandHigh:
      r.p_band_high == null || !Number.isFinite(Number(r.p_band_high))
        ? null
        : Number(r.p_band_high),
    bandLow:
      r.p_band_low == null || !Number.isFinite(Number(r.p_band_low))
        ? null
        : Number(r.p_band_low),
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

/** Corte p de "seguimiento cercano" por tenant (issue #21 Paso 1).
 *  `store_profiles.close_watch_p` nullable; NULL/inválido ⇒ 0.10.
 *  Solo display: no toca decisión ni calibración. */
export async function resolveCloseWatchP(storeId: string): Promise<number> {
  try {
    if (!isSupabaseConfigured()) return CLOSE_WATCH_DEFAULT_P;
    const { data, error } = await getSupabase()
      .from("store_profiles")
      .select("close_watch_p")
      .eq("store_id", storeId)
      .maybeSingle();
    if (error) return CLOSE_WATCH_DEFAULT_P;
    const v = (data as Record<string, unknown> | null)?.close_watch_p;
    const n = v == null ? NaN : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) return CLOSE_WATCH_DEFAULT_P;
    return n;
  } catch {
    return CLOSE_WATCH_DEFAULT_P;
  }
}

/** Cortes de banda_p por tenant (issue #21 Paso 5).
 *  `store_profiles.p_band_high/low` nullables; NULL/inválido ⇒ default del
 *  arquetipo (hoy 0.6/0.15 en todos ⇒ reproduce v2). high<=low ⇒ defaults. */
export async function resolveBandCuts(
  storeId: string,
): Promise<{ high: number; low: number }> {
  const fallback = async (): Promise<{ high: number; low: number }> => {
    const profile = await getStoreProfile(storeId).catch(() => null);
    const arch = profile?.archetype ?? "b2c_consumible";
    return BAND_CUTS_BY_ARCHETYPE[arch] ?? { high: 0.6, low: 0.15 };
  };
  try {
    if (!isSupabaseConfigured()) return fallback();
    const { data, error } = await getSupabase()
      .from("store_profiles")
      .select("p_band_high,p_band_low,archetype")
      .eq("store_id", storeId)
      .maybeSingle();
    if (error || !data) return fallback();
    const r = data as Record<string, unknown>;
    const arch = (r.archetype as ArchetypeId) ?? "b2c_consumible";
    const dflt = BAND_CUTS_BY_ARCHETYPE[arch] ?? { high: 0.6, low: 0.15 };
    const h = r.p_band_high == null ? NaN : Number(r.p_band_high);
    const l = r.p_band_low == null ? NaN : Number(r.p_band_low);
    const high = Number.isFinite(h) && h > 0 && h < 1 ? h : dflt.high;
    const low = Number.isFinite(l) && l >= 0 && l < 1 ? l : dflt.low;
    if (!(high > low)) return dflt;
    return { high, low };
  } catch {
    return fallback();
  }
}
