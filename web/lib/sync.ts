// Sync ecommerce → Supabase. Upsert-only: nunca borra (preserva source='local').
// Orquesta contra la interfaz `lib/connectors` (un conector por plataforma);
// hoy solo `medusa` tiene backend. El detalle Medusa vive en `connectors/medusa.ts`.
// Reglas puras (isRealOrder, totales, país) → `lib/canonical.ts`, nunca `lib/medusa`.
import { getSupabase } from "@/lib/supabase";
import { createLogger } from "@/lib/log";
import {
  getConnector,
  isConnectorSupported,
  ConnectorNotImplementedError,
} from "@/lib/connectors";
import type {
  CanonicalOrder,
  ConnectorPlatform,
  MedusaVersion,
  RegionMap,
  TokenLike,
} from "@/lib/connectors/types";
import {
  groupTotalsByCurrency,
  isRealOrder,
  modeCountry,
} from "@/lib/canonical";

/** Log a consola + archivo (.data/sync.log). */
const log = createLogger("sync");

/** Clave canónica del tenant: URL normalizada. */
export function normalizeShopUrl(url: string): string {
  const t = url.trim().replace(/\/+$/, "").toLowerCase();
  // Tolerante al input sin esquema ("api.tienda.com" → https://...): todo lo
  // demás (match en DB, fetch a Medusa, cache keys) asume URL absoluta.
  if (t && !t.includes("://")) return `https://${t}`;
  return t;
}

export interface SyncSummary {
  storeName: string;
  customers: number;
  orders: number;
  skippedOrders: number;
  /** Órdenes de prueba (títulos test ES/EN): se guardan con is_test, no agregan. */
  excludedTestOrders: number;
  /** Canceladas/archivadas/pago fallido: se guardan con su estado, no agregan. */
  excludedInvalidOrders: number;
  channels: number;
  markets: number;
  products: number;
  productStats: number;
}

/** Fases del sync (para el progreso en la cinta de background). */
export const SYNC_TOTAL = 6;

export interface SyncProgress {
  processed: number;
  total: number;
  current: string;
}

export interface SyncOptions {
  onProgress?: (p: SyncProgress) => void | Promise<void>;
  /** Versión de API cuando aplica (Medusa v1/v2). Sin sentido para Shopify/Woo. */
  version?: MedusaVersion | string;
}

/** Caché corta de markets por plataforma+shop (evita el doble fetch ensureStore → sync
 *  en el primer sync; los markets casi no cambian). TTL 5 min. */
const regionsCache = new Map<string, { at: number; regions: RegionMap }>();
const REGIONS_TTL_MS = 5 * 60_000;

function cacheKey(platform: ConnectorPlatform, shopUrl: string): string {
  return `${platform}:${shopUrl}`;
}

function getCachedRegions(
  platform: ConnectorPlatform,
  shopUrl: string,
): RegionMap | null {
  const key = cacheKey(platform, shopUrl);
  const hit = regionsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > REGIONS_TTL_MS) {
    regionsCache.delete(key);
    return null;
  }
  return hit.regions;
}

/** Upsert idempotente de la tienda. Devuelve su id. */
async function upsertStore(
  shopUrl: string,
  shopCurrency: string,
  platform: ConnectorPlatform = "medusa",
): Promise<string> {
  const db = getSupabase();
  const { data, error } = await db
    .from("stores")
    .upsert(
      { platform, shop_url: shopUrl, shop_currency: shopCurrency },
      { onConflict: "platform,shop_url" },
    )
    .select("id")
    .single();
  if (error || !data) throw new Error(`Store upsert: ${error?.message}`);
  return data.id as string;
}

/**
 * Crea/actualiza la tienda y devuelve su id. Necesario para registrar el run de
 * background antes de que exista el sync (la primera vez aún no hay tienda).
 */
export async function ensureStore(
  rawShopUrl: string,
  creds: TokenLike,
  platform: ConnectorPlatform = "medusa",
): Promise<string> {
  if (!isConnectorSupported(platform)) throw new ConnectorNotImplementedError(platform);
  const connector = getConnector(platform);
  const shopUrl = normalizeShopUrl(rawShopUrl);
  const regions = await fetchConnectorRegions(connector, rawShopUrl, creds);
  regionsCache.set(cacheKey(platform, shopUrl), { at: Date.now(), regions });
  const shopCurrency = Object.values(regions)[0]?.currency?.toUpperCase() || "PEN";
  return upsertStore(shopUrl, shopCurrency, platform);
}

/**
 * Lee markets del conector en forma legacy `RegionMap`.
 * Prefiere `listMarkets()` (genérica); cae a `listRegions()` (Medusa legacy).
 */
async function fetchConnectorRegions(
  connector: { listMarkets: (shopUrl: string, creds: TokenLike) => Promise<Array<{ sourceId: string; name: string; currency: string; countries: string[] }>>; listRegions?: (shopUrl: string, creds: TokenLike) => Promise<RegionMap> },
  rawShopUrl: string,
  creds: TokenLike,
): Promise<RegionMap> {
  const { marketsToRegions } = await import("@/lib/connectors/types");
  const markets = await connector.listMarkets(rawShopUrl, creds);
  if (markets.length > 0 || !connector.listRegions) return marketsToRegions(markets);
  return connector.listRegions(rawShopUrl, creds);
}

async function fetchAll<T>(
  page: (offset: number, limit: number) => Promise<{ rows: T[]; count: number }>,
): Promise<T[]> {
  const limit = 100;
  // Reintento con backoff: 4 workers en paralelo pueden comerse un 429/5xx
  // transitorio de Medusa; sin esto un throttle tumba todo el sync.
  const fetchPage = async (offset: number): Promise<{ rows: T[]; count: number }> => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await page(offset, limit);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
  // Primera página para conocer el total; el resto en paralelo (4 workers).
  // Antes eran 18 requests en serie (~300-600ms c/u = 99% del sync).
  const first = await fetchPage(0);
  const out: T[] = [...first.rows];
  if (first.rows.length < limit || out.length >= first.count) return out;
  const { mapPool } = await import("@/lib/parallel");
  const offsets: number[] = [];
  for (let off = first.rows.length; off < first.count; off += limit) offsets.push(off);
  const pages = await mapPool(offsets, 4, (off) => fetchPage(off));
  for (const p of pages) out.push(...p.rows);
  // Cola por crecimiento durante el sync: el `count` es foto del primer page;
  // si Medusa creó filas a mitad, se pesca la cola en serie (acotado).
  for (let guard = 0; guard < 10; guard++) {
    const tail = await fetchPage(out.length);
    if (tail.rows.length === 0) break;
    out.push(...tail.rows);
    if (tail.rows.length < limit) break;
  }
  return out;
}

/**
 * Sync genérico por plataforma: orquesta contra `getConnector(platform)`.
 * Agregar Shopify/Woo no toca este archivo (solo `connectors/<platform>.ts`).
 * `version` posicional es legacy Medusa (v1/v2, default "v1"); el próximo
 * proveedor la ignora. Nuevo código → `opts.version`.
 */
export async function syncStoreFromPlatform(
  platform: ConnectorPlatform,
  rawShopUrl: string,
  version: MedusaVersion | string | undefined,
  creds: TokenLike,
  opts: SyncOptions = {},
): Promise<SyncSummary> {
  if (!isConnectorSupported(platform)) throw new ConnectorNotImplementedError(platform);
  const connector = getConnector(platform);
  const db = getSupabase();
  const shopUrl = normalizeShopUrl(rawShopUrl);
  // `version` solo tiene sentido en Medusa; el conector la normaliza (v2→v2, resto→v1).
  const resolvedVersion = opts.version ?? version ?? "v1";
  const now = new Date().toISOString();
  const report = (processed: number, current: string) => {
    log(`fase ${processed + 1}/${SYNC_TOTAL}: ${current}`);
    return opts.onProgress?.({ processed, total: SYNC_TOTAL, current });
  };
  log(`start platform=${platform} shopUrl=${shopUrl}`);

  // 1. Store (tenant) + markets. Reusa caché de ensureStore
  // (mismo proceso): el primer sync ya no hace doble fetch.
  await report(0, "Tienda y mercados");
  const regions = getCachedRegions(platform, shopUrl) ?? await fetchConnectorRegions(connector, rawShopUrl, creds);
  if (!getCachedRegions(platform, shopUrl)) regionsCache.set(cacheKey(platform, shopUrl), { at: Date.now(), regions });
  const shopCurrency =
    Object.values(regions)[0]?.currency?.toUpperCase() || "PEN";
  const storeId = await upsertStore(shopUrl, shopCurrency, platform);

  const marketRows = Object.entries(regions).map(([sourceId, r]) => ({
    store_id: storeId,
    source: connector.marketSource,
    source_id: sourceId,
    name: r.name,
    currency: r.currency,
    countries: r.countries,
  }));
  if (marketRows.length > 0) {
    const { error } = await db
      .from("market_regions")
      .upsert(marketRows, { onConflict: "store_id,source,source_id" });
    if (error) throw new Error(`Markets upsert: ${error.message}`);
  }
  const { data: markets } = await db
    .from("market_regions")
    .select("id,source_id")
    .eq("store_id", storeId);
  const marketIdBySource = new Map(
    (markets ?? []).map((m) => [m.source_id as string, m.id as string]),
  );

  // Alias de fusión: los customers combinados se omiten y sus órdenes se reasignan al canónico.
  const { data: aliasData } = await db
    .from("customer_aliases")
    .select("merged_external_id,canonical_external_id")
    .eq("store_id", storeId);
  const aliasMap = new Map<string, string>(
    (aliasData ?? []).map((a) => [
      String(a.merged_external_id),
      String(a.canonical_external_id),
    ]),
  );
  const resolveExt = (ext: string): string => aliasMap.get(ext) ?? ext;

  // 2. Todos los customers + todas las orders + productos (paginado, en paralelo:
  // son endpoints independientes; antes iban en serie).
  // Products no rompe el sync: si el endpoint falla (permiso/versión), se sigue con 0.
  // productsOk distingue "feed vacío real" de "endpoint caído": solo con feed OK
  // se tombstonea lo ausente (archived); con endpoint caído tocar sería borrar
  // el catálogo por un 401.
  let productsOk = true;
  await report(1, "Descargando customers, orders y productos");
  const [customers, rawOrders, rawProducts] = await Promise.all([
    fetchAll((offset, limit) =>
      connector.listCustomers(rawShopUrl, creds, { offset, limit }, String(resolvedVersion ?? "")).then((r) => ({
        rows: r.customers,
        count: r.count,
      })),
    ),
    fetchAll((offset, limit) =>
      connector.listOrdersRaw(rawShopUrl, creds, { offset, limit }).then((r) => ({
        rows: r.orders,
        count: r.count,
      })),
    ),
    fetchAll((offset, limit) =>
      connector.listProductsRaw(rawShopUrl, creds, { offset, limit }).then((r) => ({
        rows: r.products,
        count: r.count,
      })),
    ).catch((e) => {
      productsOk = false;
      log(`products omitidos: ${e instanceof Error ? e.message : e}`);
      return [] as Array<Record<string, unknown>>;
    }),
  ]);
  const orders: CanonicalOrder[] = rawOrders
    .map((o) => connector.orderToCanonical(o, regions))
    .filter((o): o is CanonicalOrder => o !== null);
  log(`descargados customers=${customers.length} orders=${orders.length} (raw=${rawOrders.length})`);

  // 3. Channels distintos desde las orders → upsert.
  await report(2, "Canales");
  const channelByKey = new Map(
    orders
      .filter((o) => o.channel)
      .map((o) => [
        `${o.channel!.source}|${o.channel!.sourceId}`,
        { store_id: storeId, source: o.channel!.source, source_id: o.channel!.sourceId, name: o.channel!.name },
      ]),
  );
  const channelRows = [...channelByKey.values()];
  if (channelRows.length > 0) {
    const { error } = await db
      .from("channels")
      .upsert(channelRows, { onConflict: "store_id,source,source_id" });
    if (error) throw new Error(`Channels upsert: ${error.message}`);
  }
  const { data: channels } = await db
    .from("channels")
    .select("id,source,source_id")
    .eq("store_id", storeId);
  const channelIdByKey = new Map(
    (channels ?? []).map((c) => [`${c.source}|${c.source_id}`, c.id as string]),
  );

  // 4. Agregado de compras REALES por customer (por external_id, por moneda).
  // Test + canceladas/archivadas/pago fallido se guardan (auditable) pero no agregan.
  const amountsByCustomer = new Map<string, Array<{ amount: number; currency: string | null }>>();
  const lastOrderAtByCustomer = new Map<string, string>();
  let excludedTestOrders = 0;
  let excludedInvalidOrders = 0;
  for (const o of orders) {
    if (!isRealOrder(o)) {
      if (o.isTest) excludedTestOrders += 1;
      else excludedInvalidOrders += 1;
      continue;
    }
    if (!o.customerExternalId) continue;
    const key = resolveExt(o.customerExternalId);
    const arr = amountsByCustomer.get(key) ?? [];
    arr.push({ amount: o.totalAmount, currency: o.currency });
    amountsByCustomer.set(key, arr);
    // Señal de orders para el fingerprint LLM: cubre reemplazos/edits que no
    // cambian count/total (comparación por instante, no por string).
    if (o.placedAt && !Number.isNaN(Date.parse(o.placedAt))) {
      const prev = lastOrderAtByCustomer.get(key);
      if (!prev || Date.parse(o.placedAt) > Date.parse(prev)) {
        lastOrderAtByCustomer.set(key, o.placedAt);
      }
    }
  }

  // País atribuido por customer: moda del país resuelto de sus órdenes
  // reales (ver resolveOrderCountry). null = sin compras o sin país.
  const countryVotesByCustomer = new Map<string, Map<string, number>>();
  for (const o of orders) {
    if (!isRealOrder(o) || !o.country || !o.customerExternalId) continue;
    const key = resolveExt(o.customerExternalId);
    const votes = countryVotesByCustomer.get(key) ?? new Map<string, number>();
    votes.set(o.country, (votes.get(o.country) ?? 0) + 1);
    countryVotesByCustomer.set(key, votes);
  }
  const topCountry = (externalId: string): string | null =>
    modeCountry(countryVotesByCustomer.get(externalId) ?? new Map());

  // 5. Upsert customers con stats (un solo upsert).
  // orders_count/total_spent/currency = SOLO moneda primaria (nunca mezclar);
  // el desglose completo va en stats_by_currency.
  await report(3, "Guardando customers");
  const customerRows = customers
    .filter((c) => !aliasMap.has(c.id))
    .map((c) => {
      const totals = groupTotalsByCurrency(amountsByCustomer.get(resolveExt(c.id)) ?? []);
      const primary = totals[0];
      return {
        store_id: storeId,
        external_id: c.id,
        source: "ecommerce",
        email: c.email,
        phone: c.phone,
        first_name: c.firstName,
        last_name: c.lastName,
        company_name: c.companyName,
        country: topCountry(resolveExt(c.id)),
        orders_count: primary?.ordersCount ?? 0,
        total_spent: primary?.totalSpent ?? 0,
        currency: primary?.currency ?? null,
        stats_by_currency: totals.map((t) => ({
          currency: t.currency,
          ordersCount: t.ordersCount,
          totalSpent: t.totalSpent,
        })),
        last_order_at: lastOrderAtByCustomer.get(resolveExt(c.id)) ?? null,
        external_created_at: c.createdAt,
        last_synced_at: now,
      };
    });
  const customerIdByExternal = new Map<string, string>();
  for (let i = 0; i < customerRows.length; i += 500) {
    // `returning` construye el mapa external→id sin el re-read full de toda
    // la tabla que había antes (un scan paginado 1000 por sync).
    const { data: upserted, error } = await db
      .from("customers")
      .upsert(customerRows.slice(i, i + 500), { onConflict: "store_id,external_id" })
      .select("id,external_id");
    if (error) throw new Error(`Customers upsert: ${error.message}`);
    for (const c of (upserted ?? []) as Array<Record<string, unknown>>) {
      const ext = String(c.external_id ?? "");
      if (ext) customerIdByExternal.set(ext, String(c.id));
    }
  }
  // Respaldo para aliases/canónicos que el upsert no devolvió (p. ej. filas
  // omitidas por aliasMap): lecturas acotadas por external_id, nunca
  // full-scan. Chunks de 200: 500 UUIDs ≈18k chars rompen la URL (414).
  {
    const missing = customerRows
      .map((r) => String(r.external_id))
      .filter((ext) => ext && !customerIdByExternal.has(ext));
    for (let i = 0; i < missing.length; i += 200) {
      const { data: batch, error } = await db
        .from("customers")
        .select("id,external_id")
        .eq("store_id", storeId)
        .in("external_id", missing.slice(i, i + 200));
      if (error) throw new Error(`Customers read: ${error.message}`);
      for (const c of (batch ?? []) as Array<Record<string, unknown>>) {
        const ext = String(c.external_id ?? "");
        if (ext) customerIdByExternal.set(ext, String(c.id));
      }
    }
  }

  // 6. Upsert orders (solo las de customers conocidos).
  await report(4, "Guardando orders");
  const itemsByOrderId = new Map(
    rawOrders.map((o) => [
      String(o.id ?? ""),
      ((o.items as Array<Record<string, unknown>> | undefined) ?? []).map((i) => ({
        title: String(i.title ?? ""),
        quantity: Number(i.quantity ?? 0),
        unit_price: Number(i.unit_price ?? 0),
        // Captura tonta: metadata crudo del line_item (cualquier key según
        // el tipo de negocio). Null si no hay. La interpretación
        // (LLM) va en enrich, no aquí.
        metadata: (i.metadata as Record<string, unknown> | null) ?? null,
      })),
    ]),
  );
  let skippedOrders = 0;
  const orderRows = [];
  for (const o of orders) {
    const customerId =
      o.customerExternalId && customerIdByExternal.get(resolveExt(o.customerExternalId));
    if (!customerId) {
      skippedOrders += 1;
      continue;
    }
    orderRows.push({
      external_order_id: o.sourceOrderId,
      store_id: storeId,
      customer_id: customerId,
      channel_id: o.channel
        ? (channelIdByKey.get(`${o.channel.source}|${o.channel.sourceId}`) ?? null)
        : null,
      market_id: o.market ? (marketIdBySource.get(o.market.sourceId) ?? null) : null,
      total_amount: o.totalAmount,
      currency: o.currency,
      country: o.country,
      status: o.status,
      payment_status: o.paymentStatus,
      is_test: o.isTest,
      items_json: itemsByOrderId.get(o.sourceOrderId) ?? [],
      placed_at: o.placedAt,
    });
  }
  for (let i = 0; i < orderRows.length; i += 500) {
    const { error } = await db
      .from("orders")
      .upsert(orderRows.slice(i, i + 500), { onConflict: "store_id,external_order_id" });
    if (error) throw new Error(`Orders upsert: ${error.message}`);
  }

  // 7. Upsert productos (upsert-only, nunca borra). Solo escribe platform_status +
  // variants_json: is_active lo decide el trigger (override manual ?? plataforma),
  // así el sync jamás pisa lo definido en UI.
  await report(5, "Guardando productos");
  const productRows = rawProducts
    .map((p) => connector.productToCanonical(p))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({
      store_id: storeId,
      source: connector.productSource,
      source_id: p.sourceId,
      title: p.title,
      handle: p.handle,
      platform_status: p.platformStatus,
      variants_json: p.variants,
      metadata: p.metadata,
      last_synced_at: now,
    }));
  // Tolerante: si la migración products aún no se aplicó (o el endpoint
  // falla), el sync sigue y reporta 0 en vez de tumbar customers/orders.
  let productCount = 0;
  let productsPersisted = false;
  try {
    for (let i = 0; i < productRows.length; i += 500) {
      const { error } = await db
        .from("products")
        .upsert(productRows.slice(i, i + 500), { onConflict: "store_id,source,source_id" });
      if (error) throw new Error(`Products upsert: ${error.message}`);
    }
    productCount = productRows.length;
    productsPersisted = true;
  } catch (e) {
    log(`products upsert omitido: ${e instanceof Error ? e.message : e}`);
  }
  // Tombstones: lo que el feed ya no trae se marca archived (el trigger lo
  // apaga salvo override manual). SOLO con feed OK + upsert OK: con endpoint
  // caído esto borraría el catálogo por un 401.
  let tombstoned = 0;
  if (productsOk && productsPersisted) {
    try {
      const seen = new Set(productRows.map((p) => String(p.source_id)));
      // Se pagina por la tabla (nunca NOT IN gigante en URL).
      for (let off = 0; ; off += 1000) {
        const { data: page, error } = await db
          .from("products")
          .select("id,source_id")
          .eq("store_id", storeId)
          .eq("source", connector.productSource)
          .order("id", { ascending: true })
          .range(off, off + 999);
        if (error) throw new Error(`Products tombstone read: ${error.message}`);
        const gone = ((page ?? []) as Array<Record<string, unknown>>)
          .filter((r) => !seen.has(String(r.source_id ?? "")))
          .map((r) => String(r.id));
        if (gone.length > 0) {
          const { error: upErr } = await db
            .from("products")
            .update({ platform_status: "archived", last_synced_at: now })
            .in("id", gone);
          if (upErr) throw new Error(`Products tombstone write: ${upErr.message}`);
          tombstoned += gone.length;
        }
        if ((page ?? []).length < 1000) break;
      }
      if (tombstoned > 0) log(`tombstones products=${tombstoned} (archived)`);
    } catch (e) {
      log(`tombstones omitidos: ${e instanceof Error ? e.message : e}`);
    }
  }

  log(
    `done customers=${customerRows.length} orders=${orderRows.length} ` +
      `skipped=${skippedOrders} test=${excludedTestOrders} invalid=${excludedInvalidOrders} ` +
      `markets=${marketRows.length} channels=${channelRows.length} products=${productCount}`,
  );
  // Stats deterministas por (producto, moneda) para la UI y el sub-engine.
  // Tolerante como products: si la migración aún no se aplicó, se sigue.
  let productStatRows = 0;
  try {
    const { computeProductStats } = await import("@/lib/product-stats");
    const st = await computeProductStats(storeId);
    productStatRows = st.rows;
    log(`stats rows=${st.rows} matched=${st.matchedProducts} unmatched=${st.unmatchedTitles} top=${st.topUnmatched.map((u) => u.title).join(" | ").slice(0, 160)}`);
  } catch (e) {
    log(`product_stats omitido: ${e instanceof Error ? e.message : e}`);
  }
  // Nuevos customers pueden traer dominios nuevos: invalida el pending de enrich.
  await import("@/lib/enrich")
    .then((m) => m.invalidatePendingCache(storeId))
    .catch(() => {});
  return {
    storeName: shopUrl,
    customers: customerRows.length,
    orders: orderRows.length,
    skippedOrders,
    excludedTestOrders,
    excludedInvalidOrders,
    channels: channelRows.length,
    markets: marketRows.length,
    products: productCount,
    productStats: productStatRows,
  };
}

/** Compat: el sync Medusa actual. Nuevo código → `syncStoreFromPlatform`. */
export function syncStoreFromMedusa(
  medusaUrl: string,
  version: MedusaVersion,
  token: string,
  opts: SyncOptions = {},
): Promise<SyncSummary> {
  return syncStoreFromPlatform("medusa", medusaUrl, version, token, opts);
}
