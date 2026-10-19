// Finanzas simples del Overview: tendencia 12m + KPIs 30d.
// Puro cálculo sobre filas `orders` (total_amount, currency, placed_at).
// Regla de moneda: solo la moneda de la vista (tienda o market). El resto
// se ignora aquí y se muestra aparte (nunca se suman PEN+MXN).
export interface FinanceOrder {
  total_amount: number;
  currency: string | null;
  placed_at: string | null;
}

export interface MonthBucket {
  /** "2026-10" para key. */
  key: string;
  /** "oct" etiqueta corta en español. */
  label: string;
  salesMinor: number;
  orders: number;
}

export interface FinanceKpis {
  sales30dMinor: number;
  orders30d: number;
  ticket30dMinor: number;
  /** % vs 30d previos. null si no hay base. */
  salesDeltaPct: number | null;
  ordersDeltaPct: number | null;
}

const DAY_MS = 86_400_000;
const MONTH_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function sameCurrency(orderCur: string | null, viewCurrency: string | null): boolean {
  if (viewCurrency === null) return true;
  if (orderCur == null) return true;
  return orderCur.toUpperCase() === viewCurrency.toUpperCase();
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Fin de mes (ms) para una key "YYYY-MM": cierre del punto de la serie. */
export function monthEndMs(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m, 0, 23, 59, 59).getTime();
}

/** Últimos 12 meses calendario incluyendo el mes actual. */
export function last12MonthKeys(now = Date.now()): Array<{ key: string; label: string }> {
  const base = new Date(now);
  const out: Array<{ key: string; label: string }> = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push({ key: monthKey(d), label: MONTH_SHORT[d.getMonth()] });
  }
  return out;
}

export function bucketMonthly(
  orders: FinanceOrder[],
  viewCurrency: string | null,
  now = Date.now(),
): MonthBucket[] {
  const keys = last12MonthKeys(now);
  const map = new Map(keys.map((k) => [k.key, { salesMinor: 0, orders: 0 }]));
  for (const o of orders) {
    if (!sameCurrency(o.currency, viewCurrency)) continue;
    if (!o.placed_at) continue;
    const t = Date.parse(o.placed_at);
    if (Number.isNaN(t)) continue;
    const k = monthKey(new Date(t));
    const b = map.get(k);
    if (!b) continue; // fuera de la ventana 12m
    b.salesMinor += Number(o.total_amount ?? 0);
    b.orders += 1;
  }
  return keys.map((k) => ({
    ...k,
    salesMinor: map.get(k.key)?.salesMinor ?? 0,
    orders: map.get(k.key)?.orders ?? 0,
  }));
}

export interface RankedItem {
  title: string;
  quantity: number;
  revenueMinor: number;
  /** En cuántos pedidos distintos apareció. */
  orders: number;
}

export interface ItemRanking {
  top: RankedItem[];
  /** Los que menos vendieron ENTRE los que algo vendieron: el catálogo
   *  completo no se ve aquí (sin feed de productos, solo orders). */
  bottom: RankedItem[];
}

/**
 * Ranking de items por revenue (qty × unit_price) en la moneda de la vista.
 * Agrupa por título normalizado (minúsculas); títulos vacíos van a "Sin título".
 */
export function rankItems(
  orders: Array<Pick<FinanceOrder, "currency"> & { items_json: unknown }>,
  viewCurrency: string | null,
  limit = 5,
): ItemRanking {
  const byKey = new Map<string, RankedItem>();
  orders.forEach((o) => {
    if (!sameCurrency(o.currency, viewCurrency)) return;
    const items = Array.isArray(o.items_json) ? o.items_json : [];
    const seenThisOrder = new Set<string>();
    for (const raw of items) {
      const it = raw as Record<string, unknown>;
      const rawTitle = String(it.title ?? "").trim();
      const key = rawTitle.toLowerCase() || "sin-titulo";
      const qty = Number(it.quantity ?? 0) || 0;
      const price = Number(it.unit_price ?? 0) || 0;
      if (qty <= 0 && price <= 0) continue;
      let g = byKey.get(key);
      if (!g) {
        g = { title: rawTitle || "Sin título", quantity: 0, revenueMinor: 0, orders: 0 };
        byKey.set(key, g);
      }
      g.quantity += qty;
      g.revenueMinor += qty * price;
      if (!seenThisOrder.has(key)) {
        seenThisOrder.add(key);
        g.orders += 1;
      }
    }
  });
  const all = [...byKey.values()].sort((a, b) => b.revenueMinor - a.revenueMinor);
  const top = all.slice(0, limit);
  const topTitles = new Set(top.map((t) => t.title.toLowerCase()));
  const bottom = all
    .filter((r) => !topTitles.has(r.title.toLowerCase()))
    .slice(-limit)
    .reverse();
  return { top, bottom };
}

export interface RankedCustomer {
  customerId: string;
  revenueMinor: number;
  orders: number;
}

/** Top clientes por revenue en la ventana ya filtrada (12m), moneda de la vista. */
export function rankCustomers(
  orders: Array<Pick<FinanceOrder, "currency" | "total_amount"> & { customer_id: unknown }>,
  viewCurrency: string | null,
  limit = 5,
): RankedCustomer[] {
  const byId = new Map<string, RankedCustomer>();
  for (const o of orders) {
    if (!sameCurrency(o.currency, viewCurrency)) continue;
    const id = String(o.customer_id ?? "");
    if (!id) continue;
    let g = byId.get(id);
    if (!g) {
      g = { customerId: id, revenueMinor: 0, orders: 0 };
      byId.set(id, g);
    }
    g.revenueMinor += Number(o.total_amount ?? 0);
    g.orders += 1;
  }
  return [...byId.values()]
    .sort((a, b) => b.revenueMinor - a.revenueMinor)
    .slice(0, limit);
}

export interface RescateBucket {
  key: string;
  label: string;
  /** Valor en juego ≈ Σ ticket medio de vencidos (sin compra en el mes y
   *  última compra más vieja que el ciclo). Oportunidad, no pérdida. */
  enJuegoMinor: number;
  enJuegoCount: number;
  /** De dónde sale el punto: "motor" (foto de predicciones a fin de mes) o
   *  "pre-motor" (reconstrucción desde órdenes). Nunca se mezclan sin etiqueta. */
  origenEnJuego: "motor" | "pre-motor";
  /** Revenue atribuido a recuperación con fecha de acción en el mes. */
  rescatadoMinor: number;
}

export interface AttributedRevenue {
  amount: number;
  /** dispatched_at ?? created_at de la acción. */
  at: string | null;
}

type CustomerHistory = Array<{ t: number; amt: number }>;

/** Órdenes por cliente (moneda de la vista, fechas válidas ≤ now), ascendentes. */
function groupCustomerHistories(
  orders: Array<
    Pick<FinanceOrder, "currency" | "total_amount" | "placed_at"> & { customer_id: unknown }
  >,
  viewCurrency: string | null,
  now: number,
): Map<string, CustomerHistory> {
  const perCustomer = new Map<string, CustomerHistory>();
  for (const o of orders) {
    if (!sameCurrency(o.currency, viewCurrency)) continue;
    if (!o.placed_at) continue;
    const t = Date.parse(o.placed_at);
    if (Number.isNaN(t) || t > now) continue;
    const id = String(o.customer_id ?? "");
    if (!id) continue;
    const list = perCustomer.get(id) ?? [];
    list.push({ t, amt: Number(o.total_amount ?? 0) });
    perCustomer.set(id, list);
  }
  for (const list of perCustomer.values()) list.sort((a, b) => a.t - b.t);
  return perCustomer;
}

/** Vencidos a fecha `at`: sin compra desde hace más que el ciclo.
 *  Valor = Σ ticket medio acumulado del cliente (oportunidad, no pérdida). */
function overdueAt(
  histories: Map<string, CustomerHistory>,
  at: number,
  cycleMs: number,
): { valueMinor: number; count: number } {
  let valueMinor = 0;
  let count = 0;
  for (const list of histories.values()) {
    let spent = 0;
    let n = 0;
    let last = -1;
    for (const o of list) {
      if (o.t > at) break;
      spent += o.amt;
      n += 1;
      last = o.t;
    }
    if (n === 0 || last < 0) continue;
    if (at - last > cycleMs) {
      valueMinor += spent / n;
      count += 1;
    }
  }
  return { valueMinor: Math.round(valueMinor), count };
}

export interface RetentionKpis {
  rescatado30dMinor: number;
  rescatadoDeltaPct: number | null;
  enJuegoNowMinor: number;
  enJuegoNowCount: number;
}

/** KPIs de retención para la segunda fila: rescatado 30d (+delta) y en juego hoy. */
export function computeRetentionKpis(
  orders: Array<
    Pick<FinanceOrder, "currency" | "total_amount" | "placed_at"> & { customer_id: unknown }
  >,
  attributed: AttributedRevenue[],
  cycleDays: number | null,
  viewCurrency: string | null,
  now = Date.now(),
): RetentionKpis | null {
  if (cycleDays === null || cycleDays <= 0) return null;
  const histories = groupCustomerHistories(orders, viewCurrency, now);
  const nowOverdue = overdueAt(histories, now, cycleDays * DAY_MS);
  const last30 = now - 30 * DAY_MS;
  const prev30 = now - 60 * DAY_MS;
  let cur = 0;
  let prev = 0;
  for (const a of attributed) {
    if (!a.at) continue;
    const t = Date.parse(a.at);
    if (Number.isNaN(t) || t > now) continue;
    if (t >= last30) cur += Number(a.amount ?? 0);
    else if (t >= prev30) prev += Number(a.amount ?? 0);
  }
  return {
    rescatado30dMinor: cur,
    rescatadoDeltaPct: deltaPct(cur, prev),
    enJuegoNowMinor: nowOverdue.valueMinor,
    enJuegoNowCount: nowOverdue.count,
  };
}

/**
 * Chart fusionado 1+2: en juego vs rescatado por mes.
 * En juego sale del motor cuando hay foto de predicciones a fin de mes
 * (predSnapshots: Σ valor esperado actuar+revisión+vigilar, intra-moneda);
 * sin foto, reconstrucción pre-motor desde orders (honesta pero distinto
 * denominador). Cada punto lleva su origen: no se mezclan sin etiqueta.
 * Sin ciclo del tenant no hay serie en juego → null (no se inventa número).
 */
export function rescateMonthly(
  orders: Array<
    Pick<FinanceOrder, "currency" | "total_amount" | "placed_at"> & { customer_id: unknown }
  >,
  attributed: AttributedRevenue[],
  cycleDays: number | null,
  viewCurrency: string | null,
  now = Date.now(),
  predSnapshots?: Map<string, { minor: number; count: number }>,
): RescateBucket[] | null {
  if (cycleDays === null || cycleDays <= 0) return null;
  const keys = last12MonthKeys(now);
  const monthEnds = keys.map((k) => monthEndMs(k.key));
  // Órdenes por cliente (moneda de la vista, fechas válidas), ascendentes.
  const perCustomer = groupCustomerHistories(orders, viewCurrency, now);

  // Rescatado por mes (misma ventana 12m que las keys).
  const rescuedByKey = new Map<string, number>();
  for (const a of attributed) {
    if (!a.at) continue;
    const t = Date.parse(a.at);
    if (Number.isNaN(t)) continue;
    const k = monthKey(new Date(t));
    if (!keys.some((kk) => kk.key === k)) continue;
    rescuedByKey.set(k, (rescuedByKey.get(k) ?? 0) + Number(a.amount ?? 0));
  }

  const cycleMs = cycleDays * DAY_MS;
  return keys.map((k, i) => {
    const end = monthEnds[i];
    const snap = predSnapshots?.get(k.key);
    if (snap) {
      return {
        ...k,
        enJuegoMinor: Math.round(snap.minor),
        enJuegoCount: snap.count,
        origenEnJuego: "motor" as const,
        rescatadoMinor: Math.round(rescuedByKey.get(k.key) ?? 0),
      };
    }
    const overdue = overdueAt(perCustomer, end, cycleMs);
    return {
      ...k,
      enJuegoMinor: overdue.valueMinor,
      enJuegoCount: overdue.count,
      origenEnJuego: "pre-motor" as const,
      rescatadoMinor: Math.round(rescuedByKey.get(k.key) ?? 0),
    };
  });
}

function deltaPct(cur: number, prev: number): number | null {
  if (prev <= 0) return cur > 0 ? null : 0;
  return Math.round(((cur - prev) / prev) * 100);
}

export function computeFinanceKpis(
  orders: FinanceOrder[],
  viewCurrency: string | null,
  now = Date.now(),
): FinanceKpis {
  const last30 = now - 30 * DAY_MS;
  const prev30 = now - 60 * DAY_MS;
  let salesCur = 0;
  let ordersCur = 0;
  let salesPrev = 0;
  let ordersPrev = 0;
  for (const o of orders) {
    if (!sameCurrency(o.currency, viewCurrency)) continue;
    if (!o.placed_at) continue;
    const t = Date.parse(o.placed_at);
    if (Number.isNaN(t) || t > now) continue;
    const amt = Number(o.total_amount ?? 0);
    if (t >= last30) {
      salesCur += amt;
      ordersCur += 1;
    } else if (t >= prev30) {
      salesPrev += amt;
      ordersPrev += 1;
    }
  }
  return {
    sales30dMinor: salesCur,
    orders30d: ordersCur,
    ticket30dMinor: ordersCur > 0 ? Math.round(salesCur / ordersCur) : 0,
    salesDeltaPct: deltaPct(salesCur, salesPrev),
    ordersDeltaPct: deltaPct(ordersCur, ordersPrev),
  };
}
