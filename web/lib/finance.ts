// Finanzas DOOH: tendencia 12m + KPIs del mes (alineados con Hoy).
// Puro cálculo sobre líneas de IO mapeadas a FinanceOrder
// (total_amount = rate_minor, placed_at = starts_at).
// Ventana por mes calendario: mes en curso a la fecha vs mismo tramo del
// mes anterior. La tendencia 12m ya era mensual.
// Regla de moneda: solo la moneda de la vista (siempre explícita, nunca null).
// El resto se ignora (nunca se suman PEN+USD).
import { normalizeCurrency } from "@/lib/currency";
import { addMonths, firstOfMonth, monthLabelES, toMonthKey } from "@/lib/format";
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
  salesMesMinor: number;
  ordersMes: number;
  ticketMesMinor: number;
  /** % base 100 vs mismo tramo del mes anterior. null si no hay base. */
  salesDeltaPct: number | null;
  ordersDeltaPct: number | null;
}

function sameCurrency(orderCur: string | null, viewCurrency: string): boolean {
  if (orderCur == null || String(orderCur).trim() === "") return true;
  return normalizeCurrency(orderCur, "") === normalizeCurrency(viewCurrency, "");
}

/** Últimos 12 meses calendario incluyendo el mes actual. */
function last12MonthKeys(now = Date.now()): Array<{ key: string; label: string }> {
  const base = firstOfMonth(new Date(now));
  const out: Array<{ key: string; label: string }> = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = addMonths(base, -i);
    out.push({ key: toMonthKey(d), label: monthLabelES(d) });
  }
  return out;
}

export function bucketMonthly(
  orders: FinanceOrder[],
  viewCurrency: string,
  now = Date.now(),
): MonthBucket[] {
  const keys = last12MonthKeys(now);
  const map = new Map(keys.map((k) => [k.key, { salesMinor: 0, orders: 0 }]));
  for (const o of orders) {
    if (!sameCurrency(o.currency, viewCurrency)) continue;
    if (!o.placed_at) continue;
    const t = Date.parse(o.placed_at);
    if (Number.isNaN(t)) continue;
    const k = toMonthKey(new Date(t));
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

function deltaPct(cur: number, prev: number): number | null {
  if (prev <= 0) return cur > 0 ? null : 0;
  return Math.round(((cur - prev) / prev) * 100);
}

export function computeFinanceKpis(
  orders: FinanceOrder[],
  viewCurrency: string,
  now = Date.now(),
): FinanceKpis {
  // Ventana por mes calendario (alineada con Hoy): mes en curso a la fecha
  // vs el mismo tramo del mes anterior (igual cantidad de días, comparable
  // a inicio de mes). Atribución por placed_at, monto completo por orden.
  const monthStart = firstOfMonth(new Date(now)).getTime();
  const prevStart = addMonths(new Date(monthStart), -1).getTime();
  const elapsed = Math.max(0, now - monthStart);
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
    if (t >= monthStart) {
      salesCur += amt;
      ordersCur += 1;
    } else if (t >= prevStart && t < prevStart + elapsed) {
      salesPrev += amt;
      ordersPrev += 1;
    }
  }
  return {
    salesMesMinor: salesCur,
    ordersMes: ordersCur,
    ticketMesMinor: ordersCur > 0 ? Math.round(salesCur / ordersCur) : 0,
    salesDeltaPct: deltaPct(salesCur, salesPrev),
    ordersDeltaPct: deltaPct(ordersCur, ordersPrev),
  };
}
