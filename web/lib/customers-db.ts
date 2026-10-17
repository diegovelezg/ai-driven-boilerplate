// Lecturas de customers desde Supabase (source of truth para la vista).
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { searchContentCustomerIds } from "@/lib/media-context";
import { normalizeShopUrl } from "@/lib/sync";
import { domainFromEmail } from "@/lib/domains";
import { smartTitleCase } from "@/lib/text";
import {
  classifyPopulation,
  freqBucketIndex,
  SEGMENT_ORDER,
  tierBoundsOf,
  tierIndexOf,
  type PopulationRow,
  type SegmentKey,
  type TierBounds,
} from "@/lib/insights";
import type { CanonicalCustomer } from "@/lib/medusa";
import { resolveShopCurrency, resolveTenantCycleDays } from "@/lib/store-profiles";
import {
  applyScopeFilter,
  effectiveScopeFilter,
  isEmptyScope,
  type MarketScope,
} from "@/lib/markets";

export async function resolveStoreId(medusaUrl: string): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const { data } = await getSupabase()
    .from("stores")
    .select("id")
    .eq("platform", "medusa")
    .eq("shop_url", normalizeShopUrl(medusaUrl))
    .maybeSingle();
  return (data?.id as string) ?? null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Valor efectivo: override manual ?? base Medusa ("gana lo local"). */
function eff(overrides: Record<string, unknown>, key: string, base: unknown): string | null {
  return str(overrides[key]) ?? (base as string) ?? null;
}

export type ManualField = "first_name" | "last_name" | "phone" | "company_name" | "customer_type";
export const MANUAL_FIELDS: readonly ManualField[] = [
  "first_name",
  "last_name",
  "phone",
  "company_name",
  "customer_type",
];

/** Customer listo para UI editable: valores efectivos + base Medusa + qué está overrideado. */
export interface EditableCustomer extends CanonicalCustomer {
  /** UUID de la fila en Supabase (para writes). `id` sigue siendo el external_id. */
  dbId: string;
  customerType: string;
  /** ISO2 atribuido por mercado (moda de sus órdenes). null = sin país. */
  country: string | null;
  /** companyName proviene del enriquecimiento (no de Medusa ni edición manual). */
  companyNameEnriched: boolean;
  base: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    companyName: string | null;
    customerType: string;
  };
  manualFields: ManualField[];
}

export function toEditableCustomer(
  r: Record<string, unknown>,
  enrichedByDomain: Map<string, string> = new Map(),
): EditableCustomer {
  const currency = (r.currency as string) ?? null;
  const ordersCount = Number(r.orders_count ?? 0);
  const totalSpent = Number(r.total_spent ?? 0);
  // Desglose por moneda (sync lo escribe; fallback a la primaria pre-migración).
  const rawStats = (r.stats_by_currency as Array<Record<string, unknown>> | null) ?? [];
  const totalsByCurrency = rawStats.length > 0
    ? rawStats.map((t) => ({
        currency: String(t.currency ?? ""),
        ordersCount: Number(t.ordersCount ?? 0),
        totalSpent: Number(t.totalSpent ?? 0),
      }))
    : currency
      ? [{ currency, ordersCount, totalSpent }]
      : [];
  const overrides =
    (r.manual_edits as Record<string, unknown> | null) ?? {};
  const baseCustomerType = (r.customer_type as string) ?? "B2C";
  const manualFields = MANUAL_FIELDS.filter((k) => str(overrides[k]) !== null);
  // Empresa: edición manual > Medusa > enriquecimiento (por dominio).
  const overrideCompany = str(overrides["company_name"]);
  const baseCompany = (r.company_name as string) ?? null;
  const enrichedCompany =
    enrichedByDomain.get(domainFromEmail(String(r.email ?? ""))) ?? null;
  const companyName = overrideCompany ?? baseCompany ?? enrichedCompany;
  const companyNameEnriched = !overrideCompany && !baseCompany && !!enrichedCompany;
  return {
    id: String(r.external_id ?? r.id),
    dbId: String(r.id),
    email: String(r.email ?? ""),
    firstName: smartTitleCase(eff(overrides, "first_name", r.first_name)),
    lastName: smartTitleCase(eff(overrides, "last_name", r.last_name)),
    phone: eff(overrides, "phone", r.phone),
    companyName: smartTitleCase(companyName),
    companyNameEnriched,
    customerType: eff(overrides, "customer_type", baseCustomerType) ?? "B2C",
    country: (r.country as string) ?? null,
    createdAt: (r.external_created_at as string) ?? null,
    ordersCount,
    totalSpent,
    currency,
    totalsByCurrency,
    base: {
      firstName: (r.first_name as string) ?? null,
      lastName: (r.last_name as string) ?? null,
      phone: (r.phone as string) ?? null,
      companyName: (r.company_name as string) ?? null,
      customerType: baseCustomerType,
    },
    manualFields,
  };
}

export interface DbCustomersPage {
  rows: EditableCustomer[];
  totalCount: number;
}

export interface PendingCustomer {
  customer: EditableCustomer;
  inputHash: string;
}

/**
 * Customers pendientes de (re)procesamiento LLM: nunca procesados o con
 * cambios desde el último procesamiento. `needs_processing` lo mantiene el
 * trigger `customers_input_hash`; esta query no necesita comparar hashes.
 */
export async function queryPendingCustomers(
  storeId: string,
  limit = 50,
): Promise<PendingCustomer[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("customers")
    .select("*")
    .eq("store_id", storeId)
    .eq("needs_processing", true)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`DB read: ${error.message}`);
  return ((data as Array<Record<string, unknown>>) ?? []).map((r) => ({
    customer: toEditableCustomer(r),
    inputHash: String(r.input_hash ?? ""),
  }));
}

/**
 * Marca un customer como procesado. Update condicional: solo escribe si nadie
 * lo tocó en el medio (input_hash intacto); si devuelve false, re-leer.
 * `patch` = columnas de resultado del worker (se guardan en el mismo UPDATE).
 */
export async function markCustomerProcessed(
  id: string,
  inputHash: string,
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const db = getSupabase();
  const { data, error } = await db
    .from("customers")
    .update({
      ...patch,
      processed_hash: inputHash,
      processed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("input_hash", inputHash)
    .select("id");
  if (error) throw new Error(`DB write: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export type CustomersSortKey = "email" | "name" | "phone" | "company" | "orders" | "total";
export type CustomersSortDir = "asc" | "desc";
export interface CustomersSort {
  key: CustomersSortKey;
  dir: CustomersSortDir;
}

const SORT_KEYS: readonly CustomersSortKey[] = [
  "email",
  "name",
  "phone",
  "company",
  "orders",
  "total",
];

/** Valida sort/dir de searchParams; default estable email/asc (orden previo). */
export function parseCustomersSort(sp: { sort?: string; dir?: string }): CustomersSort {
  const key = SORT_KEYS.includes(sp.sort as CustomersSortKey)
    ? (sp.sort as CustomersSortKey)
    : "email";
  const dir = sp.dir === "desc" ? "desc" : "asc";
  return { key, dir };
}

/** company_name enriquecido por dominio (para poblar "Empresa" si Medusa no la trae). */
async function loadEnrichedByDomain(
  db: ReturnType<typeof getSupabase>,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, string>> {
  const firms = await loadEnrichedFirmsByDomain(db, rows);
  const map = new Map<string, string>();
  for (const [domain, firm] of firms) {
    if (firm.company) map.set(domain, firm.company);
  }
  return map;
}

/** Firmográficos enriquecidos por dominio: qué es la empresa, no solo su nombre. */
export interface EnrichedFirm {
  company: string | null;
  industry: string | null;
  description: string | null;
  size: string | null;
  location: string | null;
}

async function loadEnrichedFirmsByDomain(
  db: ReturnType<typeof getSupabase>,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, EnrichedFirm>> {
  const map = new Map<string, EnrichedFirm>();
  const domains = [
    ...new Set(rows.map((r) => domainFromEmail(String(r.email ?? ""))).filter(Boolean)),
  ];
  if (domains.length === 0) return map;
  const { data } = await db
    .from("domains")
    .select("domain,company_name,industry,description,size,location")
    .in("domain", domains);
  for (const d of (data ?? []) as Array<Record<string, unknown>>) {
    map.set(String(d.domain), {
      company: (d.company_name as string) ?? null,
      industry: (d.industry as string) ?? null,
      description: (d.description as string) ?? null,
      size: (d.size as string) ?? null,
      location: (d.location as string) ?? null,
    });
  }
  return map;
}

/** Dominios cuya ficha enriquecida matchea el término (nombre, industria, qué es…). */
async function searchEnrichedDomains(
  db: ReturnType<typeof getSupabase>,
  term: string,
  limit = 20,
): Promise<string[]> {
  const esc = term.replace(/[%_\\]/g, "\\$&").replace(/,/g, " ");
  if (!esc.trim()) return [];
  const like = `%${esc}%`;
  const { data } = await db
    .from("domains")
    .select("domain")
    .or(
      `company_name.ilike.${like},industry.ilike.${like},description.ilike.${like},size.ilike.${like},location.ilike.${like},domain.ilike.${like}`,
    )
    .limit(limit);
  return ((data ?? []) as Array<Record<string, unknown>>).map((d) => String(d.domain));
}

/** ¿El término matchea la ficha enriquecida (nombre, industria, descripción, sede, dominio)? */
function matchesEnrichedFirm(needle: string, firm: EnrichedFirm | undefined): boolean {
  if (!firm) return false;
  const hay = [firm.company, firm.industry, firm.description, firm.size, firm.location]
    .map((v) => String(v ?? "").toLowerCase())
    .filter(Boolean);
  return hay.some((h) => h.includes(needle));
}

export interface CustomerFilters {
  segment: SegmentKey | null;
  /** 0–3 = cuartil del ticket medio (misma regla que el dashboard). */
  ticketTier: number | null;
  /** 0–3 = tramo de frecuencia (1, 2, 3–5, 6+). */
  freqBucket: number | null;
  /** Solo insignia "No los pierdas" (top gasto + inactivo). */
  noLosPierdas: boolean;
}

export const NO_CUSTOMER_FILTERS: CustomerFilters = {
  segment: null,
  ticketTier: null,
  freqBucket: null,
  noLosPierdas: false,
};

/** Valida segment/ticket/freq/vip de searchParams; lo inválido se ignora. */
export function parseCustomerFilters(sp: {
  segment?: string;
  ticket?: string;
  freq?: string;
  vip?: string;
}): CustomerFilters {
  const segment = SEGMENT_ORDER.includes(sp.segment as SegmentKey)
    ? (sp.segment as SegmentKey)
    : null;
  const t = sp.ticket === undefined ? NaN : Number.parseInt(sp.ticket, 10);
  const ticketTier = t >= 0 && t <= 3 ? t : null;
  const fr = sp.freq === undefined ? NaN : Number.parseInt(sp.freq, 10);
  const freqBucket = fr >= 0 && fr <= 3 ? fr : null;
  return { segment, ticketTier, freqBucket, noLosPierdas: sp.vip === "1" };
}

export function hasCustomerFilters(f: CustomerFilters): boolean {
  return (
    f.segment !== null || f.ticketTier !== null || f.freqBucket !== null || f.noLosPierdas
  );
}

export interface CustomerFilterMeta {
  segments: Array<{ key: SegmentKey; count: number }>;
  tierBounds: TierBounds | null;
  buyers: number;
  freqBuckets: Array<{ label: string; count: number }>;
  /** Cuántos llevan la insignia "No los pierdas" (no es segmento, es tratamiento). */
  noLosPierdas: number;
}

/** Población completa para clasificar (segmento + tier). Misma fuente que el dashboard. */
async function loadPopulationRows(
  storeId: string,
  scope: Pick<MarketScope, "countries" | "customerIds"> | null = null,
): Promise<PopulationRow[]> {
  const db = getSupabase();
  const all: PopulationRow[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await applyScopeFilter(
      db
        .from("customers")
        .select("orders_count,total_spent,last_order_at,currency,customer_type")
        .eq("store_id", storeId),
      scope,
      "id",
    ).range(off, off + 999);
    if (error) throw new Error(`DB read: ${error.message}`);
    all.push(
      ...(((data as Array<Record<string, unknown>>) ?? []).map((r) => ({
        orders_count: Number(r.orders_count ?? 0),
        total_spent: Number(r.total_spent ?? 0),
        last_order_at: (r.last_order_at as string | null) ?? null,
        currency: (r.currency as string | null) ?? null,
        customer_type: (r.customer_type as string | null) ?? null,
      })) satisfies PopulationRow[]),
    );
    if (!data || data.length < 1000) break;
  }
  return all;
}

/** Conteos por segmento + cuartiles del ticket (para los dropdowns de filtro). */
export async function getCustomerFilterMeta(
  storeId: string,
  scope: MarketScope | null = null,
): Promise<CustomerFilterMeta> {
  const pop = await loadPopulationRows(storeId, scope);
  // Techo absoluto de R por ciclo del tenant (no corromper filtros si falla).
  // Tiers en la moneda del market filtrado (MX→MXN); sin filtro, la tienda.
  const [cycleDays, shopCurrency] = await Promise.all([
    resolveTenantCycleDays(storeId).catch(() => null),
    resolveShopCurrency(storeId).catch(() => null),
  ]);
  const tierCurrency = scope?.market?.currency?.toUpperCase() ?? shopCurrency;
  const classified = classifyPopulation(pop, Date.now(), cycleDays, tierCurrency);
  const counts = new Map<SegmentKey, number>();
  const avgs: number[] = [];
  let noLosPierdas = 0;
  const freqBuckets = [
    { label: "1 compra", count: 0 },
    { label: "2 compras", count: 0 },
    { label: "3–5 compras", count: 0 },
    { label: "6+ compras", count: 0 },
  ];
  for (let i = 0; i < classified.length; i += 1) {
    const c = classified[i];
    counts.set(c.segment, (counts.get(c.segment) ?? 0) + 1);
    if (c.noLosPierdas) noLosPierdas += 1;
    const b = freqBucketIndex(c.frequency);
    if (b !== null) freqBuckets[b].count += 1;
    // Tiers solo cohorte shop-currency (nunca mezclar PEN con MXN).
    const cur = pop[i]?.currency;
    if (c.avgTicketMinor === null) continue;
    if (tierCurrency !== null && cur != null && cur.toUpperCase() !== tierCurrency.toUpperCase()) continue;
    avgs.push(c.avgTicketMinor);
  }
  return {
    segments: SEGMENT_ORDER.map((key) => ({ key, count: counts.get(key) ?? 0 })).filter(
      (s) => s.count > 0,
    ),
    tierBounds: tierBoundsOf(avgs),
    buyers: pop.filter((r) => Number(r.orders_count ?? 0) > 0).length,
    freqBuckets,
    noLosPierdas,
  };
}

export async function queryStoreCustomers(
  storeId: string,
  q: string,
  page: number,
  pageSize: number,
  sort: CustomersSort = { key: "email", dir: "asc" },
  filters: CustomerFilters = NO_CUSTOMER_FILTERS,
  // Filtro global por mercado (null = todos). Por ISO2 (corto); IDs solo en
  // el fallback sin países (ver resolveMarketScope en lib/markets).
  // NULL-comodín: los sin país (r.country null) pasan cualquier filtro.
  market: MarketScope | null = null,
): Promise<DbCustomersPage> {
  // Predicado JS (misma semántica que applyScopeFilter) para los caminos
  // que resuelven en memoria. NULL-comodín: sin país pasa todo filtro.
  const inMarket = (r: Record<string, unknown>): boolean => {
    if (!market || (!market.countries && !market.customerIds)) return true;
    if (isEmptyScope(market)) return r.country == null;
    const { countries, ids } = effectiveScopeFilter(market);
    if (countries) return r.country == null || countries.includes(String(r.country));
    if (ids) return r.country == null || ids.includes(String(r.id));
    return true;
  };
  const db = getSupabase();
  const from = (page - 1) * pageSize;
  const ascending = sort.dir === "asc";
  const term = q.trim();
  const like = term ? `%${term.replace(/[%_\\]/g, "\\$&").replace(/,/g, " ")}%` : null;
  // Búsqueda en customers + empresa efectiva (Medusa) + empresa enriquecida
  // (qué es: nombre, industria, descripción…). Lo enriquecido vive en `domains`
  // (global, por dominio): se resuelve a dominios y se filtra por email.
  const enrichedDomains = like ? await searchEnrichedDomains(db, term).catch(() => []) : [];
  const enrichedEmailOr = enrichedDomains
    .map((d) => `email.ilike.%@${d}%`)
    .join(",");
  // Contenido pautado (captions Nivel 1: marca/categoría/qué anuncia) → customer ids.
  const contentIds = like ? await searchContentCustomerIds(storeId, term).catch(() => new Map()) : new Map();
  const contentIdOr = contentIds.size > 0 ? `,id.in.(${[...contentIds.keys()].join(",")})` : "";
  const searchOr = like
    ? `email.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},phone.ilike.${like},company_name.ilike.${like}${enrichedEmailOr ? `,${enrichedEmailOr}` : ""}${contentIdOr}`
    : null;

  // Con filtros (segmento/ticket) se resuelve en JS sobre la población:
  // con mercado, segmento y ticket son relativos AL MERCADO (quintiles y
  // cuartiles de su cohorte, misma regla que el dashboard y los dropdowns).
  if (hasCustomerFilters(filters)) {
    const all: Array<Record<string, unknown>> = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await db
        .from("customers")
        .select("*")
        .eq("store_id", storeId)
        .range(off, off + 999);
      if (error) throw new Error(`DB read: ${error.message}`);
      all.push(...((data as Array<Record<string, unknown>>) ?? []));
      if (!data || data.length < 1000) break;
    }
    const scoped = all.filter(inMarket);
    const pop: PopulationRow[] = scoped.map((r) => ({
      orders_count: Number(r.orders_count ?? 0),
      total_spent: Number(r.total_spent ?? 0),
      last_order_at: (r.last_order_at as string | null) ?? null,
      currency: (r.currency as string | null) ?? null,
      customer_type: (r.customer_type as string | null) ?? null,
    }));
    const [fcycleDays, fshopCurrency] = await Promise.all([
      resolveTenantCycleDays(storeId).catch(() => null),
      resolveShopCurrency(storeId).catch(() => null),
    ]);
    // Tiers en la moneda del market filtrado (MX→MXN); sin filtro, la tienda.
    const ftierCurrency = market?.market?.currency?.toUpperCase() ?? fshopCurrency;
    const classified = classifyPopulation(pop, Date.now(), fcycleDays, ftierCurrency);
    const bounds = tierBoundsOf(
      classified.flatMap((c, i) => {
        if (c.avgTicketMinor === null) return [];
        // Tiers solo cohorte de la moneda vista.
        const cur = pop[i]?.currency;
        if (
          ftierCurrency !== null &&
          cur != null &&
          cur.toUpperCase() !== ftierCurrency.toUpperCase()
        )
          return [];
        return [c.avgTicketMinor];
      }),
    );
    const firms = await loadEnrichedFirmsByDomain(db, scoped);
    const enriched = new Map<string, string>();
    for (const [domain, firm] of firms) {
      if (firm.company) enriched.set(domain, firm.company);
    }
    const needle = term.toLowerCase();
    const matched: EditableCustomer[] = [];
    scoped.forEach((r, i) => {
      const c = classified[i];
      if (filters.segment !== null && c.segment !== filters.segment) return;
      if (filters.noLosPierdas && !c.noLosPierdas) return;
      if (filters.ticketTier !== null) {
        if (c.avgTicketMinor === null || bounds === null) return;
        // Cuartiles en la moneda vista: fuera de ella el tramo no aplica.
        const cur = String(r.currency ?? "");
        if (
          ftierCurrency !== null &&
          cur !== "" &&
          cur.toUpperCase() !== ftierCurrency.toUpperCase()
        )
          return;
        if (tierIndexOf(c.avgTicketMinor, bounds) !== filters.ticketTier) return;
      }
      if (filters.freqBucket !== null && freqBucketIndex(c.frequency) !== filters.freqBucket) {
        return;
      }
      if (needle) {
        const overrides = (r.manual_edits as Record<string, unknown> | null) ?? {};
        const domain = domainFromEmail(String(r.email ?? ""));
        const hay = [
          r.email,
          r.first_name,
          r.last_name,
          r.phone,
          r.company_name,
          overrides["company_name"],
        ].map((v) => String(v ?? "").toLowerCase());
        if (
          !hay.some((h) => h.includes(needle)) &&
          !matchesEnrichedFirm(needle, firms.get(domain)) &&
          !contentIds.has(String(r.id))
        )
          return;
      }
      matched.push(toEditableCustomer(r, enriched));
    });
    const dir = ascending ? 1 : -1;
    matched.sort((a, b) => {
      // Desempate estable por email asc (igual que en SQL).
      const emailTie = a.email.localeCompare(b.email, "es", { sensitivity: "base" });
      switch (sort.key) {
        case "name": {
          const an = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim();
          const bn = `${b.firstName ?? ""} ${b.lastName ?? ""}`.trim();
          return dir * an.localeCompare(bn, "es", { sensitivity: "base" }) || emailTie;
        }
        case "phone":
          return (
            dir * (a.phone ?? "").localeCompare(b.phone ?? "", "es", { sensitivity: "base" }) ||
            emailTie
          );
        case "company": {
          const av = (a.companyName ?? "").trim();
          const bv = (b.companyName ?? "").trim();
          if (!av && !bv) return emailTie;
          if (!av) return 1; // vacíos al final
          if (!bv) return -1;
          return dir * av.localeCompare(bv, "es", { sensitivity: "base" }) || emailTie;
        }
        case "orders":
          return dir * (a.ordersCount - b.ordersCount) || emailTie;
        case "total":
          return dir * (a.totalSpent - b.totalSpent) || emailTie;
        default:
          return dir * emailTie;
      }
    });
    return { rows: matched.slice(from, from + pageSize), totalCount: matched.length };
  }

  // "Empresa" se ordena por el nombre EFECTIVO (manual > Medusa > enriquecido),
  // que puede venir del enriquecimiento por dominio → se resuelve en JS.
  if (sort.key === "company") {
    const all: Array<Record<string, unknown>> = [];
    for (let off = 0; ; off += 1000) {
      let bq = db.from("customers").select("*").eq("store_id", storeId);
      if (like && searchOr) bq = bq.or(searchOr);
      const { data, error } = await bq.range(off, off + 999);
      if (error) throw new Error(`DB read: ${error.message}`);
      all.push(...((data as Array<Record<string, unknown>>) ?? []));
      if (!data || data.length < 1000) break;
    }
    const enriched = await loadEnrichedByDomain(db, all);
    const rows = all.filter(inMarket).map((r) => toEditableCustomer(r, enriched));
    rows.sort((a, b) => {
      const av = (a.companyName ?? "").trim();
      const bv = (b.companyName ?? "").trim();
      if (!av && !bv) return 0;
      if (!av) return 1; // vacíos al final
      if (!bv) return -1;
      const c = av.localeCompare(bv, "es", { sensitivity: "base" });
      return ascending ? c : -c;
    });
    return { rows: rows.slice(from, from + pageSize), totalCount: rows.length };
  }

  let query = applyScopeFilter(
    db.from("customers").select("*", { count: "exact" }).eq("store_id", storeId),
    market,
    "id",
  );
  switch (sort.key) {
    case "email":
      query = query.order("email", { ascending });
      break;
    case "name":
      query = query
        .order("first_name", { ascending })
        .order("last_name", { ascending });
      break;
    case "phone":
      query = query.order("phone", { ascending });
      break;
    case "orders":
      query = query.order("orders_count", { ascending });
      break;
    case "total":
      query = query.order("total_spent", { ascending });
      break;
  }
  // Desempate estable para paginar sin filas duplicadas/ausentes.
  if (sort.key !== "email") query = query.order("email", { ascending: true });
  if (like && searchOr) query = query.or(searchOr);
  const { data, count, error } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(`DB read: ${error.message}`);

  const raw = (data as Array<Record<string, unknown>>) ?? [];
  const enrichedByDomain = await loadEnrichedByDomain(db, raw);
  return {
    rows: raw.map((r) => toEditableCustomer(r, enrichedByDomain)),
    totalCount: count ?? 0,
  };
}
