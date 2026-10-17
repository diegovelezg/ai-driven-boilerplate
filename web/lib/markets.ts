// Markets del tenant (SSOT del filtro global por país/mercado).
// Un market = zona comercial + moneda (Medusa region / Shopify market).
// El país ISO2 se resuelve igual que en el sync (ver resolveOrderCountry en
// lib/medusa.ts): countries único → nombre ISO2 → null.
import { getSupabase } from "@/lib/supabase";

export interface TenantMarket {
  id: string;
  name: string;
  currency: string;
  countries: string[];
}

const ISO2 = /^[A-Z]{2}$/;

/** País ISO2 que identifica al market, o null si es multi-país/sin país. */
export function marketCountry(m: Pick<TenantMarket, "name" | "countries">): string | null {
  const only = (m.countries ?? [])
    .map((c) => c.trim().toUpperCase())
    .filter((c) => ISO2.test(c));
  if (only.length === 1) return only[0];
  const name = (m.name ?? "").trim().toUpperCase();
  return ISO2.test(name) ? name : null;
}

/** Etiqueta del selector: "PE · PEN" (país si se identifica, si no nombre). */
export function displayMarket(m: TenantMarket): string {
  const cur = (m.currency ?? "").toUpperCase();
  const geo = marketCountry(m) ?? m.name;
  return cur ? `${geo} · ${cur}` : geo;
}

/** Markets de la tienda ordenados por nombre (límite 50). */
export async function listStoreMarkets(storeId: string): Promise<TenantMarket[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("market_regions")
    .select("id,name,currency,countries")
    .eq("store_id", storeId)
    .order("name", { ascending: true })
    .limit(50);
  if (error) throw new Error(`Markets read: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    currency: String(r.currency ?? ""),
    countries: ((r.countries as string[] | null) ?? []).map(String),
  }));
}

/** Valida ?market= contra los markets; null = todos (o inválido). */
export function pickRequestedMarket(
  markets: TenantMarket[],
  requestedId: string | null | undefined,
): TenantMarket | null {
  if (!requestedId) return null;
  return markets.find((m) => m.id === requestedId) ?? null;
}

/** IDs de customers con al menos una orden en el market (vía orders.market_id). */
export async function customerIdsInMarket(
  storeId: string,
  marketId: string,
): Promise<string[]> {
  const db = getSupabase();
  const ids = new Set<string>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db
      .from("orders")
      .select("customer_id")
      .eq("store_id", storeId)
      .eq("market_id", marketId)
      .range(off, off + 999);
    if (error) throw new Error(`Orders read: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>)
      ids.add(String(r.customer_id));
    if (!data || data.length < 1000) break;
  }
  return [...ids];
}

export interface MarketScope {
  market: TenantMarket | null;
  /**
   * ISO2s del market (null = sin filtro, todos). Filtra con
   * `.in("country", countries)`: corto en URL aunque sean miles de customers
   * (nunca `.in(customer_id, <miles de UUIDs>)` → "URI too long").
   * Vacío = el market no identifica a nadie (solo pasan los sin país).
   */
  countries: string[] | null;
  /**
   * Fallback solo cuando el market no declara países (sin countries ni nombre
   * ISO2): IDs vía orders.market_id. null = no aplica.
   */
  customerIds: string[] | null;
}

/** Scope parcial (lo que aceptan lecturas/tools): países y/o IDs. */
export interface MarketScopeLike {
  countries?: string[] | null;
  customerIds?: string[] | null;
}

/** true si el scope filtra y no le corresponde nadie (atajo a vacío). */
export function isEmptyScope(scope: MarketScopeLike | null): boolean {
  if (!scope || (scope.countries === null && scope.customerIds === null)) return false;
  const { countries, ids } = effectiveScopeFilter(scope);
  return countries === null && ids === null;
}

/**
 * Filtro efectivo del scope para queries: `{countries}` (ISO2 cortos,
 * preferido) o `{ids}` (fallback sin países). Ambos null = sin filtro.
 * Regla NULL-comodín: los sin país pasan cualquier filtro
 * (`country = X OR country IS NULL`); nunca `.in(<miles de UUIDs>)`.
 * Patrón en cada sitio: `q = applyScopeFilter(q, scope)` (+ `idCol` si la
 * columna de IDs no es `customer_id`).
 */
export function effectiveScopeFilter(
  scope: MarketScopeLike | null,
): { countries: string[] | null; ids: string[] | null } {
  const countries =
    scope?.countries && scope.countries.length > 0 ? scope.countries : null;
  const ids =
    !countries && scope?.customerIds && scope.customerIds.length > 0
      ? scope.customerIds
      : null;
  return { countries, ids };
}

/**
 * Aplica el scope a un builder PostgREST con columna `country`.
 * `idCol` = columna de IDs para el fallback sin países (`id` en customers,
 * `customer_id` en el resto, `null` si la tabla no tiene vínculo —p.ej.
 * leads—: el fallback filtra solo sin país). Sin filtro, intacto.
 */
export function applyScopeFilter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q: any,
  scope: MarketScopeLike | null,
  idCol: string | null = "customer_id",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (!scope) return q;
  const { countries, ids } = effectiveScopeFilter(scope);
  if (countries) return q.or(`country.in.(${countries.join(",")}),country.is.null`);
  if (ids && idCol) return q.or(`${idCol}.in.(${ids.join(",")}),country.is.null`);
  if (isEmptyScope(scope) || (ids && !idCol)) return q.is("country", null);
  return q;
}

const ISO2_LOOSE = /^[A-Za-z]{2}$/;

/**
 * Resuelve el filtro global ?market= a un scope listo para queries.
 * Países: market.countries normalizados + nombre ISO2 ("PE","MX").
 * Sin países: IDs vía orders.market_id (raro; markets bien configurados
 * siempre declaran zona). Regla NULL-comodín: los sin país (sin compras)
 * pasan cualquier filtro — se ven en todos los mercados y en "Todos".
 */
export async function resolveMarketScope(
  storeId: string,
  requestedId: string | null | undefined,
): Promise<MarketScope> {
  const markets = await listStoreMarkets(storeId);
  const market = pickRequestedMarket(markets, requestedId);
  if (!market) return { market: null, countries: null, customerIds: null };
  const seen = new Set<string>();
  for (const c of market.countries ?? []) {
    const t = c.trim().toUpperCase();
    if (ISO2_LOOSE.test(t)) seen.add(t);
  }
  const fromName = (market.name ?? "").trim().toUpperCase();
  if (ISO2_LOOSE.test(fromName)) seen.add(fromName);
  if (seen.size > 0) return { market, countries: [...seen], customerIds: null };
  return { market, countries: [], customerIds: await customerIdsInMarket(storeId, market.id) };
}

/** Añade/preserva ?market= en un href interno (null lo quita). */
export function withMarketParam(href: string, marketId: string | null): string {
  const [path, qs] = href.split("?");
  const params = new URLSearchParams(qs ?? "");
  if (marketId) params.set("market", marketId);
  else params.delete("market");
  const next = params.toString();
  return next ? `${path}?${next}` : path;
}
