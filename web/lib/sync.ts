// Sync ecommerce → Supabase. Upsert-only: nunca borra (preserva source='local').
import { getSupabase } from "@/lib/supabase";
import { createLogger } from "@/lib/log";
import {
  groupTotalsByCurrency,
  isRealOrder,
  listMedusaCustomers,
  listMedusaOrdersRaw,
  listMedusaRegions,
  medusaOrderToCanonical,
  modeCountry,
  type CanonicalOrder,
  type MedusaVersion,
} from "@/lib/medusa";

/** Log a consola + archivo (.data/sync.log). */
const log = createLogger("sync");

/** Clave canónica del tenant: URL normalizada. */
export function normalizeShopUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
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
}

/** Fases del sync (para el progreso en la cinta de background). */
export const SYNC_TOTAL = 5;

export interface SyncProgress {
  processed: number;
  total: number;
  current: string;
}

export interface SyncOptions {
  onProgress?: (p: SyncProgress) => void | Promise<void>;
}

/** Caché corta de regions por shop (evita el doble fetch ensureStore → sync
 *  en el primer sync; las regions casi no cambian). TTL 5 min. */
const regionsCache = new Map<string, { at: number; regions: Record<string, { name: string; currency: string; countries: string[] }> }>();
const REGIONS_TTL_MS = 5 * 60_000;

function getCachedRegions(shopUrl: string): Record<string, { name: string; currency: string; countries: string[] }> | null {
  const hit = regionsCache.get(shopUrl);
  if (!hit) return null;
  if (Date.now() - hit.at > REGIONS_TTL_MS) {
    regionsCache.delete(shopUrl);
    return null;
  }
  return hit.regions;
}

/** Upsert idempotente de la tienda. Devuelve su id. */
async function upsertStore(shopUrl: string, shopCurrency: string): Promise<string> {
  const db = getSupabase();
  const { data, error } = await db
    .from("stores")
    .upsert(
      { platform: "medusa", shop_url: shopUrl, shop_currency: shopCurrency },
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
export async function ensureStore(medusaUrl: string, token: string): Promise<string> {
  const shopUrl = normalizeShopUrl(medusaUrl);
  const regions = await listMedusaRegions(medusaUrl, token);
  regionsCache.set(shopUrl, { at: Date.now(), regions });
  const shopCurrency = Object.values(regions)[0]?.currency?.toUpperCase() || "PEN";
  return upsertStore(shopUrl, shopCurrency);
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

export async function syncStoreFromMedusa(
  medusaUrl: string,
  version: MedusaVersion,
  token: string,
  opts: SyncOptions = {},
): Promise<SyncSummary> {
  void version;
  const db = getSupabase();
  const shopUrl = normalizeShopUrl(medusaUrl);
  const now = new Date().toISOString();
  const report = (processed: number, current: string) => {
    log(`fase ${processed + 1}/${SYNC_TOTAL}: ${current}`);
    return opts.onProgress?.({ processed, total: SYNC_TOTAL, current });
  };
  log(`start shopUrl=${shopUrl}`);

  // 1. Store (tenant) + regions → markets. Reusa caché de ensureStore
  // (mismo proceso): el primer sync ya no hace doble fetch.
  await report(0, "Tienda y mercados");
  const regions = getCachedRegions(shopUrl) ?? await listMedusaRegions(medusaUrl, token);
  if (!getCachedRegions(shopUrl)) regionsCache.set(shopUrl, { at: Date.now(), regions });
  const shopCurrency =
    Object.values(regions)[0]?.currency?.toUpperCase() || "PEN";
  const storeId = await upsertStore(shopUrl, shopCurrency);

  const marketRows = Object.entries(regions).map(([sourceId, r]) => ({
    store_id: storeId,
    source: "medusa_region",
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

  // 2. Todos los customers + todas las orders (paginado, en paralelo:
  // son endpoints independientes; antes iban en serie).
  await report(1, "Descargando customers y orders");
  const [customers, rawOrders] = await Promise.all([
    fetchAll((offset, limit) =>
      listMedusaCustomers(medusaUrl, "v1", token, { offset, limit }).then((r) => ({
        rows: r.customers,
        count: r.count,
      })),
    ),
    fetchAll((offset, limit) =>
      listMedusaOrdersRaw(medusaUrl, token, { offset, limit }).then((r) => ({
        rows: r.orders,
        count: r.count,
      })),
    ),
  ]);
  const orders: CanonicalOrder[] = rawOrders
    .map((o) => medusaOrderToCanonical(o, regions))
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
        // Captura tonta: metadata crudo del line_item (ej. media_comments,
        // media_file del upload custom). Null si no hay. La interpretación
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

  log(
    `done customers=${customerRows.length} orders=${orderRows.length} ` +
      `skipped=${skippedOrders} test=${excludedTestOrders} invalid=${excludedInvalidOrders} ` +
      `markets=${marketRows.length} channels=${channelRows.length}`,
  );
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
  };
}
