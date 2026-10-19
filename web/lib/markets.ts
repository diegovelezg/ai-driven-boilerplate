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

/** Markets de la tienda ordenados por nombre. Si hay más de 50, valida el
 *  ?market= pedido por ID directo para no caer a "todos" por ventana. */
export async function listStoreMarkets(storeId: string, requestedId?: string | null): Promise<TenantMarket[]> {
  const db = getSupabase();
  if (requestedId) {
    const { data: one } = await db
      .from("market_regions")
      .select("id,name,currency,countries")
      .eq("store_id", storeId)
      .eq("id", requestedId)
      .maybeSingle();
    if (one) {
      const r = one as Record<string, unknown>;
      return [{
        id: String(r.id),
        name: String(r.name ?? ""),
        currency: String(r.currency ?? ""),
        countries: ((r.countries as string[] | null) ?? []).map(String),
      }];
    }
  }
  const { data, error, count } = await db
    .from("market_regions")
    .select("id,name,currency,countries", { count: "exact" })
    .eq("store_id", storeId)
    .order("name", { ascending: true })
    .limit(50);
  if (error) throw new Error(`Markets read: ${error.message}`);
  if ((count ?? 0) > 50) {
    // Nota: console directo, no @/lib/log (server-only): este módulo también
    // lo importan Client Components (market-selector) y el build lo prohíbe.
    console.warn(`[tenant] markets truncados a 50/${count} (store ${storeId}): validar ?market= por ID directo`);
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    currency: String(r.currency ?? ""),
    countries: ((r.countries as string[] | null) ?? []).map(String),
  }));
}

/** Valida ?market= contra los markets; null = sin pedir (default primario). */
export function pickRequestedMarket(
  markets: TenantMarket[],
  requestedId: string | null | undefined,
): TenantMarket | null {
  if (!requestedId) return null;
  return markets.find((m) => m.id === requestedId) ?? null;
}

/** Mercado primario: el de la moneda de la tienda, o el primero.
 *  Sin ?market= se usa este (nunca "todos": mezclar monedas confunde). */
export function pickPrimaryMarket(markets: TenantMarket[], shopCurrency: string | null): TenantMarket | null {
  if (markets.length === 0) return null;
  const cur = (shopCurrency ?? "").trim().toUpperCase();
  if (cur) {
    const hit = markets.find((m) => (m.currency ?? "").toUpperCase() === cur);
    if (hit) return hit;
  }
  return markets[0];
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
      .order("id", { ascending: true })
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
 *
 * Límite URL: el fallback por IDs mete UUIDs en la query string. Para
 * scopes chicos (< SCOPE_ID_CHUNK_SIZE) va en una sola query; para scopes
 * grandes usa los helpers chunkIds/fetchIdChunks (ver abajo) en vez de
 * esta función — un solo `.in(miles de UUIDs)` revienta con "URI too long".
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
  if (ids && idCol) {
    if (ids.length > SCOPE_ID_CHUNK_SIZE) {
      console.warn(
        `[tenant] scope por IDs grande (${ids.length}): usa fetchIdChunks en vez de applyScopeFilter para no reventar la URL`,
      );
    }
    return q.or(`${idCol}.in.(${ids.join(",")}),country.is.null`);
  }
  if (isEmptyScope(scope) || (ids && !idCol)) return q.is("country", null);
  return q;
}

/**
 * Chunk seguro para `.in()` por IDs (PostgREST revienta la URL con miles
 * de UUIDs). Patrón: `for (const c of chunkIds(ids)) { ... .in(col, c) ... }`
 * y mergear en JS (ver mira.ts). 200 UUIDs ≈ 7.2k chars en URL, bajo el
 * límite típico de 8k.
 */
export const SCOPE_ID_CHUNK_SIZE = 200;

export function chunkIds<T>(ids: T[], size: number = SCOPE_ID_CHUNK_SIZE): T[][] {
  if (size <= 0) throw new Error("chunk size debe ser > 0");
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** true si el scope fallback por IDs necesita lectura chunkeada. */
export function isLargeIdScope(scope: MarketScopeLike | null): boolean {
  const { ids } = effectiveScopeFilter(scope);
  return !!ids && ids.length > SCOPE_ID_CHUNK_SIZE;
}

/**
 * Ejecuta `fn` por chunk de IDs y concatena (con dedupe opcional por `key`).
 * Para scopes fallback grandes: primero la rama `country IS NULL` una sola
 * vez, luego un `.in(chunk)` por chunk SIN el OR-null (si no, los null se
 * duplican y el count miente). El llamador ordena/limita al final.
 */
export async function fetchIdChunks<T>(
  ids: string[],
  fn: (chunk: string[]) => Promise<T[]>,
  key?: (t: T) => string,
): Promise<T[]> {
  const out: T[] = [];
  const seen = key ? new Set<string>() : null;
  for (const c of chunkIds(ids)) {
    const rows = await fn(c);
    for (const r of rows) {
      if (!seen) {
        out.push(r);
        continue;
      }
      const k = key!(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return out;
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
  const markets = await listStoreMarkets(storeId, requestedId);
  let market = pickRequestedMarket(markets, requestedId);
  if (!market && markets.length >= 2) {
    // Sin pedir (o inválido) con 2+ markets: primario, nunca "todos".
    // Con 1 market se conserva el legacy null (una sola moneda, no confunde).
    const db = getSupabase();
    const { data: s } = await db
      .from("stores")
      .select("shop_currency")
      .eq("id", storeId)
      .maybeSingle();
    market = pickPrimaryMarket(markets, (s as Record<string, unknown> | null)?.shop_currency as string ?? null);
  }
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
