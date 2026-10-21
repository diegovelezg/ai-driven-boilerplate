// Utilidades puras de markets (SSOT del filtro global por país/mercado).
// Módulo SIN imports server: lo importan Client Components (market-selector),
// tests tsx y código servidor. Todo lo que toque Supabase vive en
// `lib/markets.ts` (server-only). Un market = zona comercial + moneda
// (Medusa region / Shopify market). El país ISO2 se resuelve igual que en
// el sync (ver resolveOrderCountry en lib/medusa.ts): countries único →
// nombre ISO2 → null.

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


/** Asigna cada cliente a un market (issue #21 Paso 3): mayoría de market_id
 *  en sus órdenes reales ≤ corte; fallback país→market; else null (legacy).
 *  Asignación única: una fila por cliente (market_id = etiqueta).
 *  Hogar puro compartido: producción (retention.ts) y tune (model-tune.ts)
 *  usan la misma partición exacta. */
export function assignMarket(
  orderMarketIds: Array<string | null>,
  customerCountry: string | null,
  markets: TenantMarket[],
): string | null {
  const counts = new Map<string, number>();
  for (const m of orderMarketIds) {
    if (!m) continue;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  if (counts.size > 0) {
    let best: string | null = null;
    let bestN = -1;
    for (const [m, n] of counts) {
      if (n > bestN || (n === bestN && (best === null || m < best))) {
        best = m;
        bestN = n;
      }
    }
    if (best && markets.some((mk) => mk.id === best)) return best;
    if (best) return best;
  }
  const cc = (customerCountry ?? "").trim().toUpperCase();
  if (cc && /^[A-Z]{2}$/.test(cc)) {
    for (const mk of markets) {
      const countries = (mk.countries ?? []).map((c) => c.trim().toUpperCase());
      if (countries.includes(cc)) return mk.id;
    }
    for (const mk of markets) {
      if (marketCountry(mk) === cc) return mk.id;
    }
  }
  return null;
}

/** Etiqueta del selector: "PE · PEN" (país si se identifica, si no nombre). */
export function displayMarket(m: TenantMarket): string {
  const cur = (m.currency ?? "").toUpperCase();
  const geo = marketCountry(m) ?? m.name;
  return cur ? `${geo} · ${cur}` : geo;
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
const SCOPE_ID_CHUNK_SIZE = 200;

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

/** Añade/preserva ?market= en un href interno (null lo quita). */
export function withMarketParam(href: string, marketId: string | null): string {
  const [path, qs] = href.split("?");
  const params = new URLSearchParams(qs ?? "");
  if (marketId) params.set("market", marketId);
  else params.delete("market");
  const next = params.toString();
  return next ? `${path}?${next}` : path;
}
