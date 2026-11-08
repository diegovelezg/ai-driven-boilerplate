// Finanzas DOOH: tendencia 12m + KPIs 30d.
// Puro cálculo sobre líneas de IO mapeadas a FinanceOrder
// (total_amount = rate_minor, placed_at = starts_at).
// Regla de moneda: solo la moneda de la vista (siempre explícita, nunca null).
// El resto se ignora (nunca se suman PEN+USD).
import { normalizeCurrency } from "@/lib/currency";
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

/** Tipos legacy del chart de recupero (motor de retención extirpado en
 *  20261122). Se conservan para los props opcionales de FinanceStrip;
 *  la página DOOH no los pobla. */
export interface RescateBucket {
  key: string;
  label: string;
  enJuegoMinor: number;
  enJuegoCount: number;
  origenEnJuego: "motor" | "pre-motor";
  rescatadoMinor: number;
}

export interface RetentionKpis {
  rescatado30dMinor: number;
  rescatadoDeltaPct: number | null;
  enJuegoNowMinor: number;
  enJuegoNowCount: number;
}

const DAY_MS = 86_400_000;
const MONTH_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function sameCurrency(orderCur: string | null, viewCurrency: string): boolean {
  if (orderCur == null || String(orderCur).trim() === "") return true;
  return normalizeCurrency(orderCur, "") === normalizeCurrency(viewCurrency, "");
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Últimos 12 meses calendario incluyendo el mes actual. */
function last12MonthKeys(now = Date.now()): Array<{ key: string; label: string }> {
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

function deltaPct(cur: number, prev: number): number | null {
  if (prev <= 0) return cur > 0 ? null : 0;
  return Math.round(((cur - prev) / prev) * 100);
}

export function computeFinanceKpis(
  orders: FinanceOrder[],
  viewCurrency: string,
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
