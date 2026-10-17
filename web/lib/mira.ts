// Ranking único de la mira (SSOT), modelo D validado en laboratorio:
// valor = ticket × prior(segmento) × exp(-días/120) × (1+lnF)/2.
// Sin score del scout (mide overdue, no probabilidad) y sin acantilados: la
// insignia "No los pierdas" es bandera visual + tier, no criterio de orden.
// Lo consumen Overview, Review, Copywriter y Strategist.
import { getSupabase } from "@/lib/supabase";
import { classifyPopulation, type SegmentKey } from "@/lib/insights";
import { resolveShopCurrency, resolveTenantCycleDays } from "@/lib/store-profiles";
import { applyScopeFilter } from "@/lib/markets";

export interface MiraRow {
  signalId: string;
  customerDbId: string;
  kind: string;
  score: number | null;
  /** Motivo crudo del scout (cada vista lo humaniza a su manera). */
  reason: string | null;
  /** Días sin comprar (null = otros tipos de señal). */
  daysSince: number | null;
  status: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  ordersCount: number;
  totalSpent: number;
  /** Moneda primaria del cliente (universo monetario, nunca mezclar). */
  currency: string | null;
  /** ISO2 atribuido (filtro global por mercado; lo escribe el copywriter). */
  country: string | null;
  segment: string;
  noLosPierdas: boolean;
  /** Último borrador de la señal (para el CTA correcto en Hoy). */
  draftStatus: "none" | "pending" | "approved" | "dispatched";
}

/** Días sin comprar extraídos del motivo crudo (null = otros tipos de señal). */
export function parseDaysSince(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.match(/sin comprar hace (\d+)d/i) ?? raw.match(/Hace (\d+) días/i);
  return m ? Number(m[1]) : null;
}

/** Ticket medio del cliente (minor units). 0 si sin compras. */
export function avgTicket(totalSpent: number, ordersCount: number): number {
  return ordersCount > 0 ? totalSpent / ordersCount : 0;
}

/** Prior de retorno por segmento (hipótesis explícitas, calibrar con medición). */
const PRIORS: Record<SegmentKey, number> = {
  "En riesgo": 0.3,
  "Campeón": 0.25,
  "Recurrente": 0.2,
  "Ocasional": 0.12,
  "Nuevo": 0.1,
  "Inactivo": 0.04,
  "Sin compras": 0,
};

/** La probabilidad de retorno decae con la antigüedad: intacta ≤180d, luego 180/días. */
export function recencyFactor(daysSince: number | null): number {
  if (daysSince === null) return 1;
  return Math.min(1, 180 / Math.max(1, daysSince));
}

/**
 * Valor esperado (modelo D): ticket × prior(segmento) × exp(-días/120) × (1+lnF)/2.
 * Premia frecuencia real, castiga antigüedad en continuo y no usa el score.
 */
export function expectedValue(
  a: Pick<MiraRow, "totalSpent" | "ordersCount" | "segment" | "daysSince"> & {
    score?: number | null;
  },
): number {
  const prior = PRIORS[a.segment as SegmentKey] ?? 0;
  const decay = a.daysSince === null ? 1 : Math.exp(-a.daysSince / 120);
  const freqW = (1 + Math.log1p(Math.max(0, a.ordersCount))) / 2;
  return avgTicket(a.totalSpent, a.ordersCount) * prior * decay * freqW;
}

/**
 * Toda la mira (open + prioritized) rankeada con el criterio único, separada
 * por universo monetario: NUNCA se mezclan PEN con MXN en un mismo ranking ni
 * en una misma suma. `rows` = moneda de la tienda (el ranking principal);
 * `foreign` = otras monedas rankeadas entre sí (no abandonadas, pero aparte).
 *
 * Dos queries simples + join en JS: el ORDER BY score deja empates arbitrarios
 * y el order por join (referencedTable) PostgREST lo ignora en silencio.
 */
export async function getRankedMira(
  storeId: string,
  limit = 100,
  // null = sin filtro de mercado (toda la tienda). Con mercado, segmentos y
  // tiers relativos a su cohorte (misma regla que overview y dropdowns).
  scope: { countries?: string[] | null; customerIds?: string[] | null; currency?: string | null } | null = null,
): Promise<{ rows: MiraRow[]; foreign: MiraRow[] }> {
  // Filtro global por mercado: ISO2 cortos (nunca miles de IDs en la URL).
  // customerIds solo en el fallback sin países (ver resolveMarketScope).
  // NULL-comodín: señales sin país se ven en todo filtro.
  const db = getSupabase();
  const sigQuery = applyScopeFilter(
    db
      .from("churn_signals")
      .select("id,customer_id,kind,score,reason,status")
      .eq("store_id", storeId)
      .in("status", ["open", "prioritized"]),
    scope,
  );
  const { data: sigRows, error: sigErr } = await sigQuery
    .order("score", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (sigErr) throw new Error(`signals read: ${sigErr.message}`);
  const sigs = ((sigRows ?? []) as Array<Record<string, unknown>>);
  if (sigs.length === 0) return { rows: [], foreign: [] };

  const ids = [...new Set(sigs.map((r) => String(r.customer_id ?? "")))];
  const [{ data: custRows }, cycleDays, shopCurrency, { data: actRows }] = await Promise.all([
    db
      .from("customers")
      .select("id,email,first_name,last_name,phone,orders_count,total_spent,currency,country")
      .eq("store_id", storeId)
      .in("id", ids),
    resolveTenantCycleDays(storeId).catch(() => null),
    resolveShopCurrency(storeId).catch(() => null),
    // Última acción por señal (la más reciente manda: rejected → redactable).
    db
      .from("proposed_actions")
      .select("signal_id,status,created_at")
      .eq("store_id", storeId)
      .in(
        "signal_id",
        sigs.map((r) => String(r.id ?? "")),
      )
      .order("created_at", { ascending: false })
      .limit(500),
  ]);
  const draftBySignal = new Map<string, MiraRow["draftStatus"]>();
  for (const a of ((actRows ?? []) as Array<Record<string, unknown>>)) {
    const sid = String(a.signal_id ?? "");
    if (!sid || draftBySignal.has(sid)) continue;
    const st = String(a.status ?? "");
    if (st === "pending_review") draftBySignal.set(sid, "pending");
    else if (st === "approved") draftBySignal.set(sid, "approved");
    else if (st === "dispatched") draftBySignal.set(sid, "dispatched");
  }
  const custById = new Map<string, Record<string, unknown>>();
  for (const c of ((custRows ?? []) as Array<Record<string, unknown>>))
    custById.set(String(c.id ?? ""), c);

  const { data: popRows } = await applyScopeFilter(
    db
      .from("customers")
      .select("id,orders_count,total_spent,last_order_at,currency")
      .eq("store_id", storeId),
    scope,
    "id",
  ).limit(5000);
  const population = ((popRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id ?? ""),
    orders_count: Number(r.orders_count ?? 0),
    total_spent: Number(r.total_spent ?? 0),
    last_order_at: (r.last_order_at as string | null) ?? null,
    currency: (r.currency as string | null) ?? null,
  }));
  const segById = new Map(
    classifyPopulation(population, Date.now(), cycleDays, scope?.currency ?? shopCurrency).map((c, i) => [population[i].id, c]),
  );

  const allRows: MiraRow[] = sigs.map((r) => {
    const c = custById.get(String(r.customer_id ?? "")) ?? {};
    const seg = segById.get(String(r.customer_id ?? ""));
    const raw = (r.reason as string | null) ?? null;
    return {
      signalId: String(r.id),
      customerDbId: String(r.customer_id ?? ""),
      kind: String(r.kind ?? "churn_risk"),
      score: r.score == null ? null : Number(r.score),
      reason: raw,
      daysSince: parseDaysSince(raw),
      status: String(r.status ?? ""),
      email: String(c.email ?? ""),
      firstName: (c.first_name as string | null) ?? null,
      lastName: (c.last_name as string | null) ?? null,
      phone: (c.phone as string | null) ?? null,
      ordersCount: Number(c.orders_count ?? 0),
      totalSpent: Number(c.total_spent ?? 0),
      currency: (c.currency as string | null) ?? null,
      country: (c.country as string | null) ?? null,
      segment: seg?.segment ?? "—",
      noLosPierdas: seg?.noLosPierdas ?? false,
      draftStatus: draftBySignal.get(String(r.id)) ?? "none",
    };
  });
  // Universos separados: misma moneda rankea junta; la foránea no contamina
  // el ranking ni las sumas de la tienda (pero sigue su propio ranking).
  // Con filtro de mercado el market YA es el universo: todo va a rows.
  const scoped = !!scope && (scope.countries != null || scope.customerIds != null);
  const inShop = (r: MiraRow) =>
    scoped ||
    shopCurrency === null ||
    r.currency === null ||
    r.currency.toUpperCase() === shopCurrency.toUpperCase();
  const rows = allRows.filter(inShop);
  const foreign = allRows.filter((r) => !inShop(r));
  rows.sort((a, b) => expectedValue(b) - expectedValue(a));
  foreign.sort((a, b) => expectedValue(b) - expectedValue(a));
  return { rows, foreign };
}
