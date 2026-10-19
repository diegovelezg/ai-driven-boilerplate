// Markets del tenant: lecturas a Supabase (solo servidor: usa service_role
// vía @/lib/supabase, nunca importar este módulo en Client Components).
// Lo puro (tipos, picks, scope, withMarketParam) vive en `lib/market-utils.ts`
// para que Client Components (market-selector) y tests lo importen sin
// arrastrar código server (rompe el build: "only available in Server
// Components"). Este módulo re-exporta lo puro por compatibilidad: el código
// servidor puede seguir importando de `@/lib/markets`.
// (Sin `import "server-only"` a propósito: los tests `tsx --test` corren en
// node plano y el paquete lanza fuera de React Server Components.)
import { getSupabase } from "@/lib/supabase";

export * from "./market-utils";
import {
  pickPrimaryMarket,
  pickRequestedMarket,
  type MarketScope,
  type TenantMarket,
} from "./market-utils";

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
    console.warn(`[tenant] markets truncados a 50/${count} (store ${storeId}): validar ?market= por ID directo`);
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    currency: String(r.currency ?? ""),
    countries: ((r.countries as string[] | null) ?? []).map(String),
  }));
}

/** IDs de customers con al menos una orden en el market (vía orders.market_id). */
async function customerIdsInMarket(
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
