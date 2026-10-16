// Sync ecommerce → Supabase. Upsert-only: nunca borra (preserva source='local').
import { getSupabase } from "@/lib/supabase";
import {
  groupTotalsByCurrency,
  listMedusaCustomers,
  listMedusaOrdersRaw,
  listMedusaRegions,
  medusaOrderToCanonical,
  type CanonicalOrder,
  type MedusaVersion,
} from "@/lib/medusa";

/** Clave canónica del tenant: URL normalizada. */
export function normalizeShopUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export interface SyncSummary {
  storeName: string;
  customers: number;
  orders: number;
  skippedOrders: number;
  channels: number;
  markets: number;
}

async function fetchAll<T>(
  page: (offset: number, limit: number) => Promise<{ rows: T[]; count: number }>,
): Promise<T[]> {
  const limit = 100;
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    const { rows, count } = await page(offset, limit);
    out.push(...rows);
    offset += rows.length;
    if (rows.length < limit || out.length >= count) break;
  }
  return out;
}

export async function syncStoreFromMedusa(
  medusaUrl: string,
  version: MedusaVersion,
  token: string,
): Promise<SyncSummary> {
  void version;
  const db = getSupabase();
  const shopUrl = normalizeShopUrl(medusaUrl);
  const now = new Date().toISOString();

  // 1. Store (tenant) + regions → markets.
  const regions = await listMedusaRegions(medusaUrl, token);
  const shopCurrency =
    Object.values(regions)[0]?.currency?.toUpperCase() || "PEN";
  const { data: store, error: storeErr } = await db
    .from("stores")
    .upsert(
      { platform: "medusa", shop_url: shopUrl, shop_currency: shopCurrency },
      { onConflict: "platform,shop_url" },
    )
    .select("id")
    .single();
  if (storeErr || !store) throw new Error(`Store upsert: ${storeErr?.message}`);
  const storeId = store.id as string;

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

  // 2. Todos los customers + todas las orders (paginado).
  const customers = await fetchAll((offset, limit) =>
    listMedusaCustomers(medusaUrl, "v1", token, { offset, limit }).then((r) => ({
      rows: r.customers,
      count: r.count,
    })),
  );
  const rawOrders = await fetchAll((offset, limit) =>
    listMedusaOrdersRaw(medusaUrl, token, { offset, limit }).then((r) => ({
      rows: r.orders,
      count: r.count,
    })),
  );
  const orders: CanonicalOrder[] = rawOrders
    .map((o) => medusaOrderToCanonical(o, regions))
    .filter((o): o is CanonicalOrder => o !== null);

  // 3. Channels distintos desde las orders → upsert.
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

  // 4. Agregado de compras por customer (por external_id, por moneda).
  const amountsByCustomer = new Map<string, Array<{ amount: number; currency: string | null }>>();
  const lastOrderAtByCustomer = new Map<string, string>();
  for (const o of orders) {
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

  // 5. Upsert customers con stats (un solo upsert).
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
        orders_count: totals.reduce((s, t) => s + t.ordersCount, 0),
        total_spent: primary?.totalSpent ?? 0,
        currency: primary?.currency ?? null,
        last_order_at: lastOrderAtByCustomer.get(resolveExt(c.id)) ?? null,
        external_created_at: c.createdAt,
        last_synced_at: now,
      };
    });
  for (let i = 0; i < customerRows.length; i += 500) {
    const { error } = await db
      .from("customers")
      .upsert(customerRows.slice(i, i + 500), { onConflict: "store_id,external_id" });
    if (error) throw new Error(`Customers upsert: ${error.message}`);
  }
  const customerIdByExternal = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data: batch, error } = await db
      .from("customers")
      .select("id,external_id")
      .eq("store_id", storeId)
      .range(from, from + 999);
    if (error) throw new Error(`Customers read: ${error.message}`);
    for (const c of batch ?? []) {
      if (c.external_id) customerIdByExternal.set(c.external_id as string, c.id as string);
    }
    if (!batch || batch.length < 1000) break;
  }

  // 6. Upsert orders (solo las de customers conocidos).
  const itemsByOrderId = new Map(
    rawOrders.map((o) => [
      String(o.id ?? ""),
      ((o.items as Array<Record<string, unknown>> | undefined) ?? []).map((i) => ({
        title: String(i.title ?? ""),
        quantity: Number(i.quantity ?? 0),
        unit_price: Number(i.unit_price ?? 0),
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

  return {
    storeName: shopUrl,
    customers: customerRows.length,
    orders: orderRows.length,
    skippedOrders,
    channels: channelRows.length,
    markets: marketRows.length,
  };
}
