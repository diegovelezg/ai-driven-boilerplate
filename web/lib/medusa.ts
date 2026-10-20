export type MedusaVersion = "v1" | "v2";

export interface CanonicalCustomer {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  companyName: string | null;
  createdAt: string | null;
  ordersCount: number;
  totalSpent: number;
  currency: string | null;
  /** Desglose por moneda (nunca sumar entre monedas). primary = totalsByCurrency[0]. */
  totalsByCurrency: CurrencyTotals[];
}

export interface CurrencyTotals {
  currency: string;
  ordersCount: number;
  totalSpent: number;
}

/** Canal de venta canónico: Medusa sales_channel / Shopify publication. */
export interface CanonicalChannelRef {
  source: "medusa_sales_channel" | "shopify_channel";
  sourceId: string;
  name: string;
}

/** Zona comercial canónica: Medusa region / Shopify market. */
export interface CanonicalMarketRef {
  source: "medusa_region" | "shopify_market";
  sourceId: string;
  name: string;
  currency: string;
  countries: string[];
}

/** Orden canónica: conserva moneda original + canal + market + país (crudo). */
export interface CanonicalOrder {
  sourceOrderId: string;
  customerEmail: string;
  customerExternalId: string | null;
  channel: CanonicalChannelRef | null;
  market: CanonicalMarketRef | null;
  totalAmount: number;
  currency: string;
  country: string | null;
  placedAt: string | null;
  /** Estado crudo Medusa (v1: pending|completed|archived|canceled|requires_action). */
  status: string | null;
  /** Estado de pago crudo (v1: captured|awaiting|...|canceled|failed). */
  paymentStatus: string | null;
  /** true si los ítems delatan una orden de prueba (ver TEST_ITEM_KEYWORDS). */
  isTest: boolean;
}

export interface CustomersPage {
  customers: CanonicalCustomer[];
  count: number;
  offset: number;
  limit: number;
}

function baseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function parseError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const j = JSON.parse(body);
    return j.message ?? j.type ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200) || res.statusText;
  }
}

/** Login JWT version-aware. v1 → access_token, v2 → token. */
export async function medusaLogin(
  url: string,
  version: MedusaVersion,
  email: string,
  password: string,
): Promise<string> {
  const path =
    version === "v1" ? "/admin/auth/token" : "/auth/user/emailpass";
  const res = await fetch(`${baseUrl(url)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}: ${await parseError(res)}`);
  const data = await res.json();
  const token = data?.access_token ?? data?.token;
  if (!token) throw new Error("Medusa: sin token en respuesta");
  return token as string;
}

async function adminGet(url: string, token: string, path: string) {
  const res = await fetch(`${baseUrl(url)}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}: ${await parseError(res)}`);
  return res.json();
}

export async function testMedusa(
  url: string,
  version: MedusaVersion,
  token: string,
): Promise<{ ok: true; store: string } | { ok: false; error: string }> {
  if (!url || !token) return { ok: false, error: "Falta URL o token" };
  try {
    const path = version === "v1" ? "/admin/store?fields=id,name" : "/admin/stores?fields=id,name";
    const data = await adminGet(url, token, path);
    const store = data?.store?.name ?? data?.stores?.[0]?.name ?? "connected";
    return { ok: true, store };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

export interface ListCustomersOptions {
  q?: string;
  offset?: number;
  limit?: number;
}

function toCanonicalCustomer(c: Record<string, unknown>): CanonicalCustomer {
  return {
    id: String(c.id ?? ""),
    email: String(c.email ?? ""),
    firstName: (c.first_name as string) ?? null,
    lastName: (c.last_name as string) ?? null,
    phone: (c.phone as string) ?? null,
    companyName:
      (c.company_name as string) ??
      ((c.billing_address as Record<string, unknown> | undefined)?.company as string) ??
      null,
    createdAt: (c.created_at as string) ?? null,
    ordersCount: 0,
    totalSpent: 0,
    currency: null,
    totalsByCurrency: [],
  };
}

export async function listMedusaCustomers(
  url: string,
  version: MedusaVersion,
  token: string,
  opts: ListCustomersOptions = {},
): Promise<CustomersPage> {
  void version;
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (opts.q?.trim()) params.set("q", opts.q.trim());
  const data = await adminGet(url, token, `/admin/customers?${params.toString()}`);
  const list = data?.customers ?? [];
  return {
    customers: list.map((c: Record<string, unknown>) => toCanonicalCustomer(c)),
    count: Number(data?.count ?? list.length),
    offset: Number(data?.offset ?? offset),
    limit: Number(data?.limit ?? limit),
  };
}

interface OrderTotal {
  amount: number;
  currency: string | null;
}

/** Totales desde el listado de orders (el list no trae `total`; payments/items sí). */
function orderAmount(o: Record<string, unknown>): OrderTotal {
  const payments = (o.payments as Array<Record<string, unknown>> | undefined) ?? [];
  const paySum = payments.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const items = (o.items as Array<Record<string, unknown>> | undefined) ?? [];
  const itemSum = items.reduce(
    (s, i) => s + Number(i.unit_price ?? 0) * Number(i.quantity ?? 0),
    0,
  );
  return {
    amount: paySum > 0 ? paySum : itemSum,
    currency: (o.currency_code as string) ?? null,
  };
}

export interface ListOrdersOptions {
  email?: string;
  offset?: number;
  limit?: number;
}

/** Órdenes crudas (incluyen payments/items para totales + region/sales_channel). */
export async function listMedusaOrdersRaw(
  url: string,
  token: string,
  opts: ListOrdersOptions = {},
): Promise<{ orders: Array<Record<string, unknown>>; count: number }> {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 100),
    offset: String(opts.offset ?? 0),
  });
  if (opts.email?.trim()) params.set("email", opts.email.trim());
  const data = await adminGet(url, token, `/admin/orders?${params.toString()}`);
  const orders = (data?.orders as Array<Record<string, unknown>>) ?? [];
  return { orders, count: Number(data?.count ?? orders.length) };
}

/** Agrupa montos por moneda — nunca sumar PEN + MXN en un solo número. */
export function groupTotalsByCurrency(
  amounts: Array<{ amount: number; currency: string | null }>,
): CurrencyTotals[] {
  const map = new Map<string, CurrencyTotals>();
  for (const a of amounts) {
    if (!a.currency) continue;
    const cur = a.currency.toLowerCase();
    const prev = map.get(cur) ?? { currency: cur, ordersCount: 0, totalSpent: 0 };
    prev.ordersCount += 1;
    prev.totalSpent += a.amount;
    map.set(cur, prev);
  }
  return [...map.values()].sort((x, y) => y.totalSpent - x.totalSpent);
}

/** Regiones Medusa (id → moneda/países). `countries` suele venir vacío. */
export async function listMedusaRegions(
  url: string,
  token: string,
): Promise<Record<string, { name: string; currency: string; countries: string[] }>> {
  const data = await adminGet(url, token, "/admin/regions?limit=100");
  const out: Record<string, { name: string; currency: string; countries: string[] }> = {};
  for (const r of (data?.regions as Array<Record<string, unknown>>) ?? []) {
    const id = String(r.id ?? "");
    if (!id) continue;
    out[id] = {
      name: String(r.name ?? id),
      currency: String(r.currency_code ?? "").toLowerCase(),
      countries: ((r.countries as Array<Record<string, unknown>> | undefined) ?? []).map((c) =>
        String(c.iso_2 ?? c.name ?? ""),
      ).filter(Boolean),
    };
  }
  return out;
}

/** Estados de orden que NO cuentan como compra real (RFM/agregados). */
const EXCLUDED_ORDER_STATUSES = new Set([
  "canceled",
  "cancelled",
  "archived",
  "requires_action",
]);

/** Estados de pago que NO cuentan como compra real. */
const EXCLUDED_PAYMENT_STATUSES = new Set(["canceled", "cancelled", "failed"]);

/**
 * Palabras que delatan ítems de prueba, ES + EN. Se matchea por palabra
 * completa (no subcadena): "test" marca "Prueba MX" pero no "contest".
 */
const TEST_ITEM_KEYWORDS = [
  "prueba",
  "pruebas",
  "probando",
  "test",
  "tests",
  "testing",
  "teste",
  "draft",
  "drafts",
  "borrador",
  "borradores",
  "dummy",
  "fake",
  "fakes",
  "ejemplo",
  "ejemplos",
  "example",
  "examples",
  "demo",
  "demos",
];

const TEST_ITEM_RE = new RegExp(`\\b(${TEST_ITEM_KEYWORDS.join("|")})\\b`, "i");

/** true si el título del ítem parece de prueba (ES/EN, palabra completa). */
function isTestItemTitle(title: string): boolean {
  return TEST_ITEM_RE.test(title.trim());
}

/** true si algún ítem de la orden parece de prueba. */
function isTestOrder(
  items: Array<{ title?: unknown } | Record<string, unknown>>,
): boolean {
  return items.some((i) =>
    isTestItemTitle(String((i as Record<string, unknown>).title ?? "")),
  );
}

/** true si la orden canónica cuenta como compra real (no test, no cancelada…). */
export function isRealOrder(o: Pick<CanonicalOrder, "status" | "paymentStatus" | "isTest">): boolean {
  if (o.isTest) return false;
  if (o.status && EXCLUDED_ORDER_STATUSES.has(o.status.toLowerCase())) return false;
  if (o.paymentStatus && EXCLUDED_PAYMENT_STATUSES.has(o.paymentStatus.toLowerCase())) return false;
  return true;
}

/** true si una fila DB de orders cuenta como compra real (issue #11/#12).
 *  Unifica el criterio: analyst y copywriter usaban un filtro inline que
 *  ignoraba payment_status y requires_action. */
export function isRealDbOrder(o: {
  status?: string | null;
  payment_status?: string | null;
  paymentStatus?: string | null;
  is_test?: boolean | null;
  isTest?: boolean | null;
}): boolean {
  return isRealOrder({
    status: o.status ?? null,
    paymentStatus: (o.payment_status ?? o.paymentStatus ?? null) as string | null,
    isTest: Boolean(o.is_test ?? o.isTest ?? false),
  });
}

/**
 * País canónico ISO2 de una orden — general medusa v1/v2 + shopify.
 * Cascada (primera que resuelva gana):
 *   1. country crudo: shipping_address.country_code → billing_address.country_code
 *      (Medusa v1/v2 y Shopify exponen ISO2 aquí cuando hay dirección).
 *   2. market.countries con un único ISO2 (region de un solo país).
 *   3. nombre del market si es ISO2 ("PE", "MX", "CL").
 *   4. null = sin país (bienes digitales, checkout sin dirección).
 * Shopify mapea igual: shipping/billing country_code → shopify_market.
 */
export function resolveOrderCountry(
  raw: string | null | undefined,
  market: Pick<CanonicalMarketRef, "name" | "countries"> | null,
): string | null {
  const iso = (v: string | null | undefined): string | null => {
    const t = (v ?? "").trim().toUpperCase();
    return /^[A-Z]{2}$/.test(t) ? t : null;
  };
  const fromRaw = iso(raw);
  if (fromRaw) return fromRaw;
  if (market) {
    const only = (market.countries ?? []).map((c) => iso(c)).filter((c) => c !== null);
    if (only.length === 1) return only[0];
    const fromName = iso(market.name);
    if (fromName) return fromName;
  }
  return null;
}

/**
 * Moda con desempate alfabético determinista (para atribuciones por país:
 * customer ← órdenes, lead ← referencias). null si no hay votos.
 */
export function modeCountry(votes: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [c, n] of votes) {
    if (n > bestN || (n === bestN && (best === null || c < best))) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

/** Mapea una order cruda de Medusa v1 al modelo canónico (channel + market + moneda). */
export function medusaOrderToCanonical(
  o: Record<string, unknown>,
  regions: Record<string, { name: string; currency: string; countries: string[] }> = {},
): CanonicalOrder | null {
  const id = o.id as string | undefined;
  const currency = (o.currency_code as string | undefined)?.toLowerCase();
  if (!id || !currency) return null;
  const region = o.region as Record<string, unknown> | undefined;
  const sc = (o.sales_channel ?? o.salesChannel) as Record<string, unknown> | undefined;
  const ship = o.shipping_address as Record<string, unknown> | undefined;
  const bill = o.billing_address as Record<string, unknown> | undefined;
  const regionId = region?.id as string | undefined;
  const reg = (regionId && regions[regionId]) || null;
  const items = (o.items as Array<Record<string, unknown>> | undefined) ?? [];
  // canceled_at sin status cancelado ocurre: normalizar a 'canceled'.
  const status = o.canceled_at ? "canceled" : ((o.status as string) ?? null);
  const market: CanonicalOrder["market"] = regionId
    ? {
        source: "medusa_region",
        sourceId: String(regionId),
        name: String(region?.name ?? reg?.name ?? regionId),
        currency: ((region?.currency_code as string) ?? reg?.currency ?? currency).toLowerCase(),
        countries: reg?.countries ?? [],
      }
    : null;
  return {
    sourceOrderId: String(id),
    customerEmail: String(o.email ?? ""),
    customerExternalId: (o.customer_id as string) ?? null,
    channel: sc?.id
      ? {
          source: "medusa_sales_channel",
          sourceId: String(sc.id),
          name: String(sc.name ?? sc.id),
        }
      : null,
    market,
    totalAmount: orderAmount(o).amount,
    currency,
    country: resolveOrderCountry(
      (ship?.country_code as string) ?? (bill?.country_code as string) ?? null,
      market,
    ),
    placedAt: (o.created_at as string) ?? null,
    status,
    paymentStatus: (o.payment_status as string) ?? null,
    isTest: isTestOrder(items),
  };
}

/** Producto crudo de Medusa (v1: status draft/proposed/published/rejected). */
export async function listMedusaProductsRaw(
  url: string,
  token: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<{ products: Array<Record<string, unknown>>; count: number }> {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 100),
    offset: String(opts.offset ?? 0),
  });
  const data = await adminGet(url, token, `/admin/products?${params.toString()}`);
  const products = (data?.products as Array<Record<string, unknown>>) ?? [];
  return { products, count: Number(data?.count ?? products.length) };
}

/** Producto canónico mínimo para `products` (el trigger SQL decide is_active). */
export interface CanonicalProduct {
  sourceId: string;
  title: string;
  handle: string | null;
  platformStatus: string | null;
  variants: Array<{
    sku: string | null;
    title: string;
    quantity: number;
    unit_price: number;
  }>;
  metadata: Record<string, unknown> | null;
}

export function medusaProductToCanonical(
  p: Record<string, unknown>,
): CanonicalProduct | null {
  const id = p.id as string | undefined;
  const title = (p.title as string | undefined)?.trim();
  if (!id || !title) return null;
  const variants = ((p.variants as Array<Record<string, unknown>> | undefined) ?? []).map((v) => ({
    sku: (v.sku as string | undefined) ?? null,
    title: String(v.title ?? ""),
    quantity: Number(v.inventory_quantity ?? 0),
    unit_price: Number(
      (v.prices as Array<Record<string, unknown>> | undefined)?.[0]?.amount ?? 0,
    ),
  }));
  return {
    sourceId: String(id),
    title,
    handle: (p.handle as string | undefined) ?? null,
    platformStatus: ((p.status as string | undefined) ?? null)?.toLowerCase() ?? null,
    variants,
    metadata: {
      tags: p.tags ?? null,
      collection: p.collection ?? null,
    },
  };
}

// El formato vive en un único módulo (`lib/format`): miles "." y decimales ",".
export { formatMoney } from "@/lib/format";
