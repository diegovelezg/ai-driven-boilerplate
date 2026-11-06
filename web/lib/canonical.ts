// Reglas canónicas puras (sin backend ecommerce).
// La ingesta es Sheet/CSV (DOOH). Este módulo solo conserva tipos + reglas
// usadas por lecturas legacy (customers/orders) y tests de reglas.

export interface CurrencyTotals {
  currency: string;
  ordersCount: number;
  totalSpent: number;
}

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
  totalsByCurrency: CurrencyTotals[];
}

export interface CanonicalChannelRef {
  source: string;
  sourceId: string;
  name: string;
}

export interface CanonicalMarketRef {
  source: string;
  sourceId: string;
  name: string;
  currency: string;
  countries: string[];
}

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
  status: string | null;
  paymentStatus: string | null;
  isTest: boolean;
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

/** Estados de orden que NO cuentan como compra real (RFM/agregados). */
export const EXCLUDED_ORDER_STATUSES = new Set([
  "canceled",
  "cancelled",
  "archived",
  "requires_action",
]);

/** Estados de pago que NO cuentan como compra real. */
export const EXCLUDED_PAYMENT_STATUSES = new Set(["canceled", "cancelled", "failed"]);

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
export function isTestOrder(
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
 * País canónico ISO2 de una orden (single-país: el país del tenant manda,
 * el crudo de la orden solo informa).
 * Cascada (primera que resuelva gana):
 *   1. country crudo (ISO2 de dirección).
 *   2. market.countries con un único ISO2 (deprecated, sin markets).
 *   3. nombre del market si es ISO2 (deprecated).
 *   4. null = sin país.
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

/** Expuesto para tests de reglas (los ítems de prueba Tumban órdenes enteras). */
export const __testing = { isTestOrder, isTestItemTitle };
