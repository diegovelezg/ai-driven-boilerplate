// Ranking único de la mira (SSOT): ordena por valor esperado del motor
// probabilístico (`valor_esperado_minor` desc, desempate `p_recompra_h` desc).
// Sin predicción (tienda sin corrida aún), la fila queda al final ordenada por
// antigüedad (hecho temporal, sinscores ni segmentos).
// Lo consumen Overview, Review, Copywriter y Strategist.
import { getSupabase } from "@/lib/supabase";
import { resolveShopCurrency } from "@/lib/store-profiles";
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
  /** Empresa del cliente (company_name; el brief dossier-first la usa como identidad). */
  companyName: string | null;
  /** Último borrador de la señal (para el CTA correcto en Hoy). */
  draftStatus: "none" | "pending" | "approved" | "dispatched";
  /** Motor probabilístico (opcional para no romper consumidores). */
  pRecompraH?: number | null;
  decision?: string | null;
  expectedDays?: number | null;
  valorEsperadoMinor?: number | null;
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
  // null = sin filtro de mercado (toda la tienda).
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
  const [{ data: custRows }, shopCurrency, { data: actRows }, { data: predRows }] = await Promise.all([
    db
      .from("customers")
      .select("id,email,first_name,last_name,phone,company_name,orders_count,total_spent,currency,country")
      .eq("store_id", storeId)
      .in("id", ids),
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
    // Última predicción por cliente (el ranking principal).
    db
      .from("customer_predictions")
      .select("customer_id,valor_esperado_minor,p_recompra_h,decision,expected_days,as_of")
      .eq("store_id", storeId)
      .in("customer_id", ids)
      .order("as_of", { ascending: false })
      .limit(1000)
      .then(
        (res) => res,
        () => ({ data: null as null }),
      ),
  ]);
  const predByCust = new Map<
    string,
    { valor: number | null; p: number | null; decision: string | null; expectedDays: number | null }
  >();
  for (const r of ((predRows ?? []) as Array<Record<string, unknown>> | null) ?? []) {
    const cid = String(r.customer_id ?? "");
    if (!cid || predByCust.has(cid)) continue;
    predByCust.set(cid, {
      valor: r.valor_esperado_minor == null ? null : Number(r.valor_esperado_minor),
      p: r.p_recompra_h == null ? null : Number(r.p_recompra_h),
      decision: (r.decision as string | null) ?? null,
      expectedDays: r.expected_days == null ? null : Number(r.expected_days),
    });
  }
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

  const allRows: MiraRow[] = sigs.map((r) => {
    const c = custById.get(String(r.customer_id ?? "")) ?? {};
    const raw = (r.reason as string | null) ?? null;
    const pred = predByCust.get(String(r.customer_id ?? "")) ?? null;
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
      companyName: (c.company_name as string | null) ?? null,
      ordersCount: Number(c.orders_count ?? 0),
      totalSpent: Number(c.total_spent ?? 0),
      currency: (c.currency as string | null) ?? null,
      country: (c.country as string | null) ?? null,
      draftStatus: draftBySignal.get(String(r.id)) ?? "none",
      pRecompraH: pred?.p ?? null,
      decision: pred?.decision ?? null,
      expectedDays: pred?.expectedDays ?? null,
      valorEsperadoMinor: pred?.valor ?? null,
    };
  });
  // Ranking principal: valor_esperado_minor desc, desempate p_recompra_h desc.
  // Sin predicción (tienda sin corrida aún): al final, por antigüedad.
  const rankKey = (r: MiraRow): [number, number, number] => [
    r.valorEsperadoMinor ?? -1,
    r.pRecompraH ?? -1,
    r.daysSince ?? -1,
  ];
  const cmp = (a: MiraRow, b: MiraRow) => {
    const ka = rankKey(a);
    const kb = rankKey(b);
    // Sin predicción queda al final, ordenado por antigüedad.
    if ((a.valorEsperadoMinor == null) !== (b.valorEsperadoMinor == null)) {
      return a.valorEsperadoMinor == null ? 1 : -1;
    }
    for (let i = 0; i < 3; i += 1) {
      if (kb[i] !== ka[i]) return kb[i] - ka[i];
    }
    return 0;
  };
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
  rows.sort(cmp);
  foreign.sort(cmp);
  return { rows, foreign };
}
