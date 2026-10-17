// Agregados de inteligencia para el Overview: segmentación RFM + frecuencia/ticket.
// Puramente cálculo sobre filas `customers` (orders_count, total_spent, last_order_at).
// Misma regla que `lib/customer-data.ts` (quintiles + segmentos) para no diverger.
export type SegmentKey =
  | "Campeón"
  | "Recurrente"
  | "Ocasional"
  | "En riesgo"
  | "Inactivo"
  | "Nuevo"
  | "Sin compras";

export interface PopulationRow {
  orders_count: number;
  total_spent: number;
  last_order_at: string | null;
  /** Moneda primaria del cliente (minor units de total_spent). Sin esto se
   *  mezclan PEN con MXN en el quintil M y los tiers. */
  currency?: string | null;
  /** Tipo B2B/B2C (agregado byType). */
  customer_type?: string | null;
}

function quintile(sortedAsc: number[], v: number): number {
  const n = sortedAsc.length;
  if (n <= 1) return 3;
  const below = sortedAsc.filter((x) => x < v).length;
  const equal = sortedAsc.filter((x) => x === v).length;
  const rankMid = below + (equal - 1) / 2;
  return Math.min(5, 1 + Math.floor((rankMid / (n - 1)) * 5));
}

function segmentOf(r: number | null, f: number): SegmentKey {
  if (f === 0) return "Sin compras";
  if (f === 1 && (r ?? 0) >= 4) return "Nuevo";
  if ((r ?? 0) >= 4 && f >= 4) return "Campeón";
  if ((r ?? 0) >= 3 && f >= 3) return "Recurrente";
  if ((r ?? 5) <= 2 && f >= 3) return "En riesgo";
  if ((r ?? 5) <= 2) return "Inactivo";
  return "Ocasional";
}

const DAY_MS = 86_400_000;

/**
 * Techo absoluto de Recencia por ciclo del tenant: en bases dormidas el quintil
 * relativo dice R≥4 a quien lleva 262d sin comprar ("Campeón" fantasma). La
 * escalera son múltiplos del ciclo, dinámica por tenant vía
 * resolveTenantCycleDays (perfil → arquetipo).
 */
export function absoluteRecencyScore(
  recencyDays: number | null,
  cycleDays: number | null,
): number | null {
  if (recencyDays === null || cycleDays === null || cycleDays <= 0) return null;
  if (recencyDays <= cycleDays) return 5;
  if (recencyDays <= 2 * cycleDays) return 4;
  if (recencyDays <= 4 * cycleDays) return 3;
  if (recencyDays <= 8 * cycleDays) return 2;
  return 1;
}

function recencyDays(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((now - d.getTime()) / DAY_MS));
}

export interface Insights {
  segments: Array<{ key: SegmentKey; count: number }>;
  buyers: number;
  freqBuckets: Array<{ label: string; count: number }>;
  avgTicketMinor: number;
  /** Mediana del ticket medio por cliente (robusta a ballenas). */
  medianTicketMinor: number;
  /** Distribución del ticket medio por cliente en cuartiles (upToMinor null = +∞). */
  ticketTiers: Array<{ upToMinor: number | null; count: number }>;
  /** Patrones por tipo de cliente (B2B/B2C): quién vale y quién reincide. */
  byType: Array<{
    type: string;
    buyers: number;
    avgSpentMinor: number;
    repeatRate: number;
    atRiskRate: number;
  }>;
}

/** Clasificación por cliente: segmento RFM + ticket medio. Base de los
 *  agregados del dashboard Y de los filtros de /customers (misma función,
 *  mismos resultados en ambos lados). */
export interface ClassifiedCustomer {
  frequency: number;
  totalSpentMinor: number;
  segment: SegmentKey;
  /** Ticket medio del cliente (minor units). null si sin compras. */
  avgTicketMinor: number | null;
  /** Quintil M (gasto vs la tienda). null si sin compras. */
  m: number | null;
  /** Insignia "No los pierdas" (Can't Lose Them): top gasto + inactivo.
   *  Nivel tratamiento sobre el segmento único, no un segmento más. */
  noLosPierdas: boolean;
}

export function classifyPopulation(
  rows: PopulationRow[],
  now = Date.now(),
  cycleDays: number | null = null,
  /** Moneda de la tienda: el quintil M y la insignia solo valen intra-moneda.
   *  R/F (días/conteos) no mezclan nada y se calculan para todos. */
  shopCurrency: string | null = null,
): ClassifiedCustomer[] {
  const fleshed = rows.map((r) => ({
    f: Number(r.orders_count ?? 0),
    m: Number(r.total_spent ?? 0),
    rec: recencyDays(r.last_order_at, now),
    cur: (r.currency ?? null) as string | null,
  }));
  const rPop = fleshed
    .filter((r) => r.f > 0)
    .map((r) => r.rec)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  const mPop = fleshed
    .filter((r) => r.f > 0 && (shopCurrency === null || r.cur === null || r.cur.toUpperCase() === shopCurrency.toUpperCase()))
    .map((r) => r.m)
    .sort((a, b) => a - b);
  return fleshed.map((row) => {
    // Segmento = R (quintil invertido, con techo absoluto por ciclo) + F cruda,
    // igual que customer-data.ts.
    const rQuint = row.f > 0 && row.rec !== null ? 6 - quintile(rPop, row.rec) : null;
    const rCap = row.rec !== null ? absoluteRecencyScore(row.rec, cycleDays) : null;
    const r = rQuint !== null && rCap !== null ? Math.min(rQuint, rCap) : rQuint;
    // M solo intra-moneda: fuera de la moneda de la tienda no hay quintil (m null).
    const inShop =
      shopCurrency === null || row.cur === null || row.cur.toUpperCase() === shopCurrency.toUpperCase();
    const m = row.f > 0 && inShop ? quintile(mPop, row.m) : null;
    return {
      frequency: row.f,
      totalSpentMinor: row.m,
      segment: segmentOf(r, row.f),
      avgTicketMinor: row.f > 0 ? row.m / row.f : null,
      m,
      noLosPierdas: m === 5 && r !== null && r <= 2,
    };
  });
}

/** Cuartiles [q1, mediana, q3] redondeados (minor units). null si vacío. */
export type TierBounds = [number, number, number];

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function tierBoundsOf(avgs: number[]): TierBounds | null {
  if (avgs.length === 0) return null;
  const sorted = [...avgs].sort((a, b) => a - b);
  const q1 = medianOf(sorted.slice(0, Math.floor(sorted.length / 2)));
  const median = medianOf(sorted);
  const q3 = medianOf(sorted.slice(Math.ceil(sorted.length / 2)));
  return [Math.round(q1), Math.round(median), Math.round(q3)];
}

/** Tramo 0–3 del ticket medio según los cuartiles (misma regla en dashboard y filtros). */
export function tierIndexOf(avg: number, bounds: TierBounds): number {
  const [q1, median, q3] = bounds;
  if (avg <= q1) return 0;
  if (avg <= median) return 1;
  if (avg <= q3) return 2;
  return 3;
}

/** Tramo de frecuencia 0–3 (1, 2, 3–5, 6+). null si sin compras. */
export function freqBucketIndex(f: number): number | null {
  if (f === 1) return 0;
  if (f === 2) return 1;
  if (f >= 3 && f <= 5) return 2;
  if (f >= 6) return 3;
  return null;
}

export const SEGMENT_ORDER: SegmentKey[] = [
  "Campeón",
  "Recurrente",
  "Ocasional",
  "Nuevo",
  "En riesgo",
  "Inactivo",
  "Sin compras",
];

export function computeInsights(
  rows: PopulationRow[],
  now = Date.now(),
  cycleDays: number | null = null,
  shopCurrency: string | null = null,
): Insights {
  const classified = classifyPopulation(rows, now, cycleDays, shopCurrency);
  // Agregados monetarios solo cohorte shop-currency (promedio/mediana/tiers
  // nunca mezclan PEN con MXN). Segmentos y frecuencia son globales.
  const inShop = (r: PopulationRow) =>
    shopCurrency === null ||
    r.currency == null ||
    r.currency.toUpperCase() === shopCurrency.toUpperCase();

  const counts = new Map<SegmentKey, number>();
  for (const c of classified) counts.set(c.segment, (counts.get(c.segment) ?? 0) + 1);
  const segments = SEGMENT_ORDER.map((key) => ({ key, count: counts.get(key) ?? 0 })).filter(
    (s) => s.count > 0,
  );

  const freqBuckets: Array<{ label: string; count: number }> = [
    { label: "1 compra", count: 0 },
    { label: "2 compras", count: 0 },
    { label: "3–5", count: 0 },
    { label: "6+", count: 0 },
  ];
  let totalMinor = 0;
  let totalOrders = 0;
  const avgs: number[] = [];
  for (let i = 0; i < classified.length; i += 1) {
    const c = classified[i];
    const b = freqBucketIndex(c.frequency);
    if (b !== null) freqBuckets[b].count += 1;
    if (c.avgTicketMinor === null || !inShop(rows[i])) continue;
    totalMinor += c.totalSpentMinor;
    totalOrders += c.frequency;
    avgs.push(c.avgTicketMinor);
  }

  const bounds = tierBoundsOf(avgs);
  const ticketTiers: Array<{ upToMinor: number | null; count: number }> =
    bounds === null
      ? []
      : [
          { upToMinor: bounds[0], count: 0 },
          { upToMinor: bounds[1], count: 0 },
          { upToMinor: bounds[2], count: 0 },
          { upToMinor: null, count: 0 },
        ];
  for (const a of avgs) {
    if (bounds !== null) ticketTiers[tierIndexOf(a, bounds)].count += 1;
  }

  return {
    segments,
    buyers: rows.filter((r) => Number(r.orders_count ?? 0) > 0).length,
    freqBuckets,
    avgTicketMinor: totalOrders > 0 ? Math.round(totalMinor / totalOrders) : 0,
    medianTicketMinor: bounds === null ? 0 : bounds[1],
    ticketTiers,
    byType: buildByType(rows, classified, shopCurrency),
  };
}

/** Agregado por customer_type: gasto medio, % con 2+ compras, % en riesgo/inactivo. */
function buildByType(
  rows: PopulationRow[],
  classified: ClassifiedCustomer[],
  shopCurrency: string | null = null,
): Insights["byType"] {
  const groups = new Map<string, { spent: number; nSpent: number; n: number; repeat: number; atRisk: number }>();
  rows.forEach((r, i) => {
    const f = Number(r.orders_count ?? 0);
    if (f === 0) return;
    const t = (r.customer_type ?? "—").trim() || "—";
    const g = groups.get(t) ?? { spent: 0, nSpent: 0, n: 0, repeat: 0, atRisk: 0 };
    // Gasto solo intra-moneda (nunca sumar PEN+MXN).
    const sameCur =
      shopCurrency === null ||
      r.currency == null ||
      r.currency.toUpperCase() === shopCurrency.toUpperCase();
    if (sameCur) {
      g.spent += Number(r.total_spent ?? 0);
      g.nSpent += 1;
    }
    g.n += 1;
    if (f >= 2) g.repeat += 1;
    const seg = classified[i]?.segment;
    if (seg === "En riesgo" || seg === "Inactivo") g.atRisk += 1;
    groups.set(t, g);
  });
  return [...groups.entries()]
    .map(([type, g]) => ({
      type,
      buyers: g.n,
      avgSpentMinor: g.nSpent > 0 ? Math.round(g.spent / g.nSpent) : 0,
      repeatRate: g.n > 0 ? Math.round((g.repeat / g.n) * 100) : 0,
      atRiskRate: g.n > 0 ? Math.round((g.atRisk / g.n) * 100) : 0,
    }))
    .sort((a, b) => b.buyers - a.buyers);
}
