import Link from "next/link";
import {
  Brain,
  ListChecks,
  PenLine,
  Radar,
  Send,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { countDuplicateEmails } from "@/lib/duplicates";
import { pendingDomains } from "@/lib/enrich";
import { formatMoney } from "@/lib/medusa";
import { resolveTenantCycleDays } from "@/lib/store-profiles";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { applyScopeFilter, displayMarket, resolveMarketScope, withMarketParam, type MarketScope } from "@/lib/markets";
import {
  displayStoreName,
  getActiveStore,
  type TenantStore,
} from "@/lib/tenant";
import { AgentCard, ClickStop } from "./ask-agent";
import { AttentionTable, type AttentionItem } from "./attention-table";
import { FinanceStrip } from "./finance-strip";
import { InsightStrip } from "./insight-strip";
import { SectionLoading } from "@/components/section-loading";
import {
  bucketMonthly,
  computeFinanceKpis,
  computeRetentionKpis,
  rescateMonthly,
  type AttributedRevenue,
  type FinanceKpis,
  type MonthBucket,
  type RetentionKpis,
} from "@/lib/finance";
import {
  computeInsights,
  type Insights,
  type PopulationRow,
} from "@/lib/insights";
import { avgTicket, expectedValue, getRankedMira } from "@/lib/mira";

export const instant = false;

type StoreRow = TenantStore;

type AttentionRow = AttentionItem;

interface RunRow {
  kind: string;
  label: string;
  status: string;
  summary: string | null;
  started_at: string;
}

interface TeamProfile {
  vertical: string | null;
  buyerType: string | null;
  cycle: number | null;
  archetype: string | null;
  confidence: string | null;
  learnedAt: string | null;
}

async function countExact(
  table: "churn_signals" | "proposed_actions" | "customers" | "proposed_leads" | "orders",
  storeId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: (q: any) => any,
  // Filtro global por mercado (null = todos). Señales/acciones filtran por
  // su country desnormalizado; customers por el suyo (id solo en fallback).
  // NULL-comodín: los sin país se ven en todo filtro.
  scope: MarketScope | null = null,
  idCol: string | null = "customer_id",
): Promise<number> {
  const db = getSupabase();
  const q = applyScopeFilter(
    apply(db.from(table).select("id", { count: "exact", head: true }).eq("store_id", storeId)),
    scope,
    idCol,
  );
  const { count, error } = await q;
  if (error) throw new Error(`${table} count: ${error.message}`);
  return count ?? 0;
}

/** "sin comprar hace 64d (media 30d, ...)" → "Hace 64 días que no compra · suele volver cada 30d".
 *  Chequeo de contradicción: si lleva 10× su ciclo sin comprar, el ciclo ya no
 *  es creíble y decir "suele volver cada 2d" es absurdo. */
function humanReason(raw: string | null, fallbackKind: string): string {
  if (!raw) return fallbackKind;
  const m = raw.match(/sin comprar hace (\d+)d \(media (\d+)d/i);
  if (m) {
    const since = Number(m[1]);
    const cycle = Math.max(1, Number(m[2]));
    if (since > 10 * cycle)
      return `Hace ${m[1]} días que no compra · sin ritmo detectable de recompra`;
    return `Hace ${m[1]} días que no compra · suele volver cada ${m[2]}d`;
  }
  return raw;
}

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "ayer";
  if (d < 30) return `hace ${d} días`;
  return `hace ${Math.floor(d / 30)} meses`;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; market?: string }>;
}) {
  const dbReady = isSupabaseConfigured();
  const sp = await searchParams;

  if (!dbReady) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">
            Supabase no configurado (`supabase start` + `web/.env.local`).
          </CardContent>
        </Card>
      </div>
    );
  }

  const db = getSupabase();
  let stores: StoreRow[] = [];
  let active: StoreRow | null = null;
  let storesError: string | null = null;
  try {
    const resolved = await getActiveStore(sp.store);
    stores = resolved.stores;
    active = resolved.active;
  } catch (e) {
    storesError = e instanceof Error ? e.message : "DB read failed";
  }
  if (storesError) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">
            Stores read: {storesError}
          </CardContent>
        </Card>
      </div>
    );
  }
  if (stores.length === 0 || !active) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <p className="text-[13px] text-muted-foreground">
              Conecta tu tienda para empezar a recuperar clientes.
            </p>
            <Button render={<Link href="/settings" />} nativeButton={false} variant="outline" size="sm">
              Ir a Settings
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Tenant activo resuelto por lib/tenant (?store > conexión legacy > primera).
  // stores vacío ya retornó arriba (sin tiendas sincronizadas).

  let error: string | null = null;
  let open = 0;
  let prioritized = 0;
  let pending = 0;
  let approved = 0;
  let dispatched = 0;
  let buyers = 0;
  let leadsPending = 0;
  let revenue = 0;
  let converted = 0;
  let attention: AttentionRow[] = [];
  let runs: RunRow[] = [];
  let duplicateCount = 0;
  let enrichPending = 0;
  let recentOrders = 0;
  let miraValue = 0;
  let masivos = 0;
  let topLead: AttentionRow | null = null;
  let foreignLines: Array<{ code: string; n: number; value: number }> = [];
  let insights: Insights | null = null;
  let financeBuckets: MonthBucket[] = [];
  let financeKpis: FinanceKpis | null = null;
  let rescate: ReturnType<typeof rescateMonthly> = null;
  let cycleDays: number | null = null;
  let retention: RetentionKpis | null = null;
  let team: TeamProfile = { vertical: null, buyerType: null, cycle: null, archetype: null, confidence: null, learnedAt: null };
  // Filtro global por país/mercado (?market= del header). Segmentos e insignias
  // se calculan sobre toda la tienda (quintiles estables); lo que se filtra es
  // el contenido operativo: conteos, mira, revenue y órdenes.
  let scope: MarketScope = { market: null, countries: null, customerIds: null };

  try {
    scope = await resolveMarketScope(active.id, sp.market).catch(() => scope);
    const weekAgoIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const yearAgoIso = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const [
      openN,
      priN,
      pendN,
      apprN,
      dispN,
      buyersN,
      leadsN,
      dupN,
      enrichN,
      recentN,
      revRows,
      runRows,
      profileRow,
      popRows,
      finRows,
    ] = await Promise.all([
      countExact("churn_signals", active.id, (q) => q.in("status", ["open"]), scope),
      countExact("churn_signals", active.id, (q) => q.eq("status", "prioritized"), scope),
      countExact("proposed_actions", active.id, (q) => q.eq("status", "pending_review"), scope),
      countExact("proposed_actions", active.id, (q) => q.eq("status", "approved"), scope),
      countExact("proposed_actions", active.id, (q) => q.eq("status", "dispatched"), scope),
      countExact("customers", active.id, (q) => q.gt("orders_count", 0), scope, "id"),
      countExact("proposed_leads", active.id, (q) => q.eq("status", "pending_review"), scope, null),
      countDuplicateEmails(active.id, scope).catch(() => 0),
      pendingDomains(active.id, scope).then((d) => d.length).catch(() => 0),
      countExact("orders", active.id, (q) => {
        let nq = q.gte("placed_at", weekAgoIso);
        // Market exacto + NULL-comodín (órdenes sin país se ven en todo).
        if (scope.market) nq = nq.or(`market_id.eq.${scope.market.id},country.is.null`);
        return nq;
      }).catch(() => 0),
      (async () => {
        const rq = applyScopeFilter(
          db
            .from("proposed_actions")
            .select("revenue_attributed,dispatched_at,created_at")
            .eq("store_id", active.id)
            .not("revenue_attributed", "is", null),
          scope,
        );
        return rq.limit(500);
      })(),
      db
        .from("background_runs")
        .select("kind,label,status,summary,started_at")
        .eq("store_id", active.id)
        .order("started_at", { ascending: false })
        .limit(10),
      db
        .from("store_profiles")
        .select("vertical_detected,buyer_type,repurchase_cycle_days,archetype,interpretation_confidence,interpreted_at")
        .eq("store_id", active.id)
        .maybeSingle(),
      applyScopeFilter(
        db
          .from("customers")
          .select("orders_count,total_spent,last_order_at,currency,customer_type")
          .eq("store_id", active.id),
        scope,
        "id",
      ).limit(5000),
      (async () => {
        let fq = db
          .from("orders")
          .select("total_amount,currency,placed_at,customer_id")
          .eq("store_id", active.id)
          .gte("placed_at", yearAgoIso)
          .order("placed_at", { ascending: false });
        // Mismo criterio que recentOrders: market exacto + NULL-comodín.
        if (scope.market) fq = fq.or(`market_id.eq.${scope.market.id},country.is.null`);
        return fq.limit(5000);
      })(),
    ]);
    open = openN;
    prioritized = priN;
    pending = pendN;
    approved = apprN;
    dispatched = dispN;
    buyers = buyersN;
    leadsPending = leadsN;
    duplicateCount = dupN;
    enrichPending = enrichN;
    recentOrders = recentN;

    const revs = ((revRows.data ?? []) as Array<Record<string, unknown>>).map((r) =>
      Number(r.revenue_attributed ?? 0),
    );
    revenue = revs.reduce((a, b) => a + b, 0);
    converted = revs.filter((v) => v > 0).length;

    if (popRows.error) throw new Error(`customers population: ${popRows.error.message}`);
    // Techo absoluto de R por ciclo del tenant (bases dormidas no coronan Campeones).
    // Con mercado, segmentos y tiers relativos a su cohorte (misma moneda).
    const tenantCycleDays = await resolveTenantCycleDays(active.id).catch(() => null);
    insights = computeInsights(
      ((popRows.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        orders_count: Number(r.orders_count ?? 0),
        total_spent: Number(r.total_spent ?? 0),
        last_order_at: (r.last_order_at as string | null) ?? null,
        currency: (r.currency as string | null) ?? null,
        customer_type: (r.customer_type as string | null) ?? null,
      })) satisfies PopulationRow[],
      Date.now(),
      tenantCycleDays,
      scope.market?.currency?.toUpperCase() ?? active.shop_currency,
    );

    // Finanzas simples: solo moneda de la vista, nunca se mezclan monedas.
    // Límite 5000 igual que popRows: suficiente para el MVP, se refina si crece.
    if (!finRows.error) {
      const finOrders = ((finRows.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        total_amount: Number(r.total_amount ?? 0),
        currency: (r.currency as string | null) ?? null,
        placed_at: (r.placed_at as string | null) ?? null,
        customer_id: r.customer_id,
      }));
      const viewCur = scope.market?.currency?.toUpperCase() ?? active.shop_currency;
      financeBuckets = bucketMonthly(finOrders, viewCur);
      financeKpis = computeFinanceKpis(finOrders, viewCur);
      // En juego vs rescatado: atribuido con fecha de acción en el mes.
      const attributed: AttributedRevenue[] = (
        (revRows.data ?? []) as Array<Record<string, unknown>>
      ).map((r) => ({
        amount: Number(r.revenue_attributed ?? 0),
        at: ((r.dispatched_at as string | null) ?? (r.created_at as string | null) ?? null),
      }));
      cycleDays = tenantCycleDays;
      rescate = rescateMonthly(finOrders, attributed, tenantCycleDays, viewCur);
      retention = computeRetentionKpis(finOrders, attributed, tenantCycleDays, viewCur);
    }

    // Ranking único (lib/mira): mismo criterio en Overview, Review y Copywriter.
    // Si Pepita es top en Hoy, es top en todos lados. Universos monetarios
    // separados: pool = moneda de la tienda; foreign se muestra aparte.
    // Con filtro de mercado el market es el universo (mira no parte en dos).
    const { rows: pool, foreign } = await getRankedMira(active.id, 100, {
      ...scope,
      currency: scope.market?.currency?.toUpperCase() ?? null,
    });
    // Hoy = solo accionable 1-a-1 (insignia o ≤365d), tope 5 ("tus 5 de hoy").
    // La masa antigua no se lista fila por fila: va con reactivación masiva.
    // El resto espera en Review (inbox): el dashboard no satura.
    const actionable = pool.filter((a) => a.noLosPierdas || (a.daysSince ?? 0) <= 365);
    attention = actionable.slice(0, 5).map(
      (r): AttentionRow => ({
        signalId: r.signalId,
        customerDbId: r.customerDbId,
        kind: r.kind,
        score: r.score,
        reason: humanReason(r.reason, r.kind),
        daysSince: r.daysSince,
        email: r.email,
        name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
        ordersCount: r.ordersCount,
        totalSpent: r.totalSpent,
        segment: r.segment,
        noLosPierdas: r.noLosPierdas,
        draftStatus: r.draftStatus,
      }),
    );
    masivos = pool.length - actionable.length;
    // Puerta de entrada del funnel: el #1 con el criterio único (sea insignia o no).
    topLead = attention[0] ?? null;
    miraValue = pool.reduce((acc, a) => acc + expectedValue(a), 0);
    // Otras monedas: conteo y valor aparte, nunca sumados a los S/.
    {
      const byCur = new Map<string, { n: number; value: number }>();
      for (const f of foreign) {
        const code = (f.currency ?? "?").toUpperCase();
        const g = byCur.get(code) ?? { n: 0, value: 0 };
        g.n += 1;
        g.value += expectedValue(f);
        byCur.set(code, g);
      }
      foreignLines = [...byCur.entries()].map(([code, g]) => ({ code, n: g.n, value: g.value }));
    }

    runs = ((runRows.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      kind: String(r.kind ?? ""),
      label: String(r.label ?? ""),
      status: String(r.status ?? ""),
      summary: (r.summary as string | null) ?? null,
      started_at: String(r.started_at ?? ""),
    }));
    const p = (profileRow.data ?? {}) as Record<string, unknown>;
    team = {
      vertical: (p.vertical_detected as string | null) ?? null,
      buyerType: (p.buyer_type as string | null) ?? null,
      cycle: (p.repurchase_cycle_days as number | null) ?? null,
      archetype: (p.archetype as string | null) ?? null,
      confidence: (p.interpretation_confidence as string | null) ?? null,
      learnedAt: (p.interpreted_at as string | null) ?? null,
    };
  } catch (e) {
    error = e instanceof Error ? e.message : "DB read failed";
  }

  const atRisk = open + prioritized;
  const riskPct = buyers > 0 ? Math.round((atRisk / buyers) * 100) : 0;
  // Minor units → moneda real (formatMoney divide ÷100; no formatear a mano).
  // Con filtro de mercado los montos van en la moneda del market (MX→MXN).
  const viewCurrency = scope.market?.currency?.toUpperCase() ?? active.shop_currency;
  const money = (n: number) => formatMoney(Math.round(n), viewCurrency);
  const storeName = displayStoreName(active);
  const marketLabel = scope.market ? displayMarket(scope.market) : null;
  const reviewHref = withMarketParam("/review", scope.market?.id ?? null);

  const lastRun = (kinds: string[]): RunRow | null =>
    runs.find((r) => kinds.includes(r.kind)) ?? null;
  const bgRunning = (kinds: string[]): boolean =>
    runs.some((r) => kinds.includes(r.kind) && r.status === "running");
  const scoutRun = lastRun(["scout"]);
  const strategistRun = lastRun(["strategist"]);
  const copywriterRun = lastRun(["copywriter"]);
  const prospectRun = lastRun(["prospect"]);
  const dispatcherRun = lastRun(["dispatcher"]);
  const analystRun = lastRun(["analyst"]);

  const runLine = (r: RunRow | null, idle: string) =>
    !r ? (
      idle
    ) : r.status === "running" ? (
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />
        generando ahora mismo…
      </span>
    ) : (
      `trabajó ${ago(r.started_at) ?? "recientemente"}${r.summary ? ` · ${r.summary}` : ""}`
    );

  const learnedAgo = ago(team.learnedAt);
  const needsRecheck =
    team.learnedAt != null &&
    // eslint-disable-next-line react-hooks/purity
    Date.now() - Date.parse(team.learnedAt) > 30 * 86_400_000;

  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold tracking-tight">
            {atRisk > 0
              ? `Hola, ${storeName} — hoy tienes ${atRisk} ${atRisk === 1 ? "cliente" : "clientes"} por recuperar`
              : `Todo al día, ${storeName}`}
          </h1>
          <span className="text-xs text-muted-foreground">
            {atRisk > 0
              ? `${riskPct}% de tus ${buyers} compradores debería haber vuelto ya`
              : "Ningún cliente vencido. Tu equipo IA sigue vigilando."}
            {marketLabel ? ` · viendo ${marketLabel}` : ""}
          </span>
        </div>
        {stores.length > 1 && (
          <span className="flex flex-wrap items-center gap-2">
            {stores.map((s) => (
              <Button
                key={s.id}
                render={<Link href={s.id === active.id ? withMarketParam("/", scope.market?.id ?? null) : `/?store=${s.id}`} />}
                nativeButton={false}
                variant={s.id === active.id ? "default" : "outline"}
                size="sm"
              >
                {displayStoreName(s)}
              </Button>
            ))}
          </span>
        )}
      </header>

      {error && (
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">{error}</CardContent>
        </Card>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Por recuperar
            </span>
            <span className="text-2xl font-semibold tabular-nums tracking-tight">{atRisk}</span>
            <span className="text-xs text-muted-foreground">
              {buyers > 0 ? `${riskPct}% de tus ${buyers} compradores` : "conecta y sincroniza para empezar"}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Mensajes listos
            </span>
            <span className="text-2xl font-semibold tabular-nums tracking-tight">{pending}</span>
            <span className="text-xs text-muted-foreground">
              {pending > 0 ? (
                <>para revisar y enviar por WhatsApp · <Link href={reviewHref} className="underline">revisar ahora</Link></>
              ) : (
                "sin borradores pendientes"
              )}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Recuperado
            </span>
            <span className="text-2xl font-semibold tabular-nums tracking-tight">{money(revenue)}</span>
            <span className="text-xs text-muted-foreground">{converted} clientes volvieron</span>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Embudo de recuperación">
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Embudo de recuperación
            </span>
            <p className="text-[13px] tabular-nums">
              En la mira <strong>{atRisk}</strong> ({money(miraValue)})
              {foreignLines.map((fl) => (
                <span key={fl.code}>
                  {" "}+{fl.n} en {fl.code} ({formatMoney(Math.round(fl.value), fl.code)})
                </span>
              ))}
              {" → "}Con
              borrador <strong>{pending}</strong>{" → "}Aprobados{" "}
              <strong>{approved}</strong>{" → "}Recuperados{" "}
              <strong>{converted}</strong> ({money(revenue)})
            </p>
            <p className="text-[13px]">
              Lo próximo:{" "}
              {pending > 0 ? (
                <Link href={reviewHref} className="underline">
                  revisa {pending} {pending === 1 ? "borrador" : "borradores"}
                </Link>
              ) : approved > 0 ? (
                `${approved} ${approved === 1 ? "aprobado listo" : "aprobados listos"} para enviar`
              ) : atRisk > 0 ? (
                "contacta a tu mira de hoy"
              ) : (
                "nada — todo al día"
              )}
              {topLead && (
                <>
                  {" "}· Empieza por {topLead.name} (
                  {money(avgTicket(topLead.totalSpent, topLead.ordersCount))} ticket)
                  {topLead.noLosPierdas ? ", No los pierdas." : "."}
                </>
              )}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {recentOrders} {recentOrders === 1 ? "compra" : "compras"} últimos 7
              días.
            </p>
          </CardContent>
        </Card>
      </section>

      {financeKpis && (
        <FinanceStrip
          buckets={financeBuckets}
          kpis={financeKpis}
          currency={viewCurrency}
          recoveredMinor={revenue}
          marketLabel={marketLabel}
          rescate={rescate}
          cycleDays={cycleDays}
          retention={retention ?? undefined}
        />
      )}

      {insights && (
        <InsightStrip insights={insights} currency={viewCurrency} storeId={active.id} marketLabel={marketLabel} />
      )}

      <section>
        <h2 className="mb-1 text-sm font-medium">Tu equipo IA</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Cada agente hace una parte por ti. Tú solo revisas y apruebas — ellos vigilan, proponen y miden.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <AgentCard storeId={active.id} storeName={storeName}>
            <CardContent className="flex flex-col gap-2 p-4">
              <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Brain className="size-3.5 text-primary" aria-hidden /> Comprende tu negocio
              </span>
              <span className="text-[13px]">
                {team.vertical ?? "Aún no me enseñaste tu negocio"}
                {team.buyerType ? ` · ${team.buyerType}` : ""}
                {team.cycle ? ` · tus clientes vuelven cada ~${team.cycle}d` : ""}
              </span>
              <span className="text-xs text-muted-foreground">
                Aprendo qué vendes, a quién y cada cuánto deberían volver.
                {learnedAgo ? ` Te calibré ${learnedAgo}` : " Aún sin calibrar"}
                {team.confidence ? ` · confianza ${team.confidence}` : ""}
                {needsRecheck ? " · ¿cambió tu negocio? conviene recalibrarme" : ""}
              </span>
              <ClickStop className="mt-1">
                <Button render={<Link href="/settings" />} nativeButton={false} variant="outline" size="sm">
                  {team.vertical ? "Revisar lo aprendido" : "Enseñarle mi negocio"}
                </Button>
              </ClickStop>
            </CardContent>
          </AgentCard>
          <AgentCard storeId={active.id} storeName={storeName}>
            <CardContent className="flex flex-col gap-2 p-4">
              <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Radar className="size-3.5 text-primary" aria-hidden /> Vigilan recompras
              </span>
              <span className="flex items-start gap-2 text-[13px]">
                <Radar className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <strong>Scout</strong> detecta quién debería haber vuelto ya.
                  <span className="block text-xs text-muted-foreground">{runLine(scoutRun, "aún sin primera vigilancia")}</span>
                </span>
              </span>
              <span className="flex items-start gap-2 text-[13px]">
                <ListChecks className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <strong>Estratega</strong> ordena por valor para que atiendas lo importante primero.
                  <span className="block text-xs text-muted-foreground">
                    {atRisk > 0 ? `${atRisk} en la mira · ` : ""}
                    {runLine(strategistRun, "aún sin priorizar")}
                  </span>
                </span>
              </span>
            </CardContent>
          </AgentCard>
          <AgentCard storeId={active.id} storeName={storeName}>
            <CardContent className="flex flex-col gap-2 p-4">
              <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <PenLine className="size-3.5 text-primary" aria-hidden /> Proponen por ti
              </span>
              <span className="flex items-start gap-2 text-[13px]">
                <PenLine className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <strong>Redactor</strong> escribe el mensaje en tu tono, listo para tu visto bueno.
                  <span className="block text-xs text-muted-foreground">
                    {pending > 0 ? `${pending} listos · ` : ""}
                    {runLine(copywriterRun, "aún sin borradores")}
                  </span>
                </span>
              </span>
              <span className="flex items-start gap-2 text-[13px]">
                <UserPlus className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <strong>Prospector</strong> busca negocios parecidos a tu cliente ideal.
                  <span className="block text-xs text-muted-foreground">
                    {leadsPending > 0 ? `${leadsPending} por revisar · ` : ""}
                    {runLine(prospectRun, "aún sin prospectar")}
                  </span>
                </span>
              </span>
              {pending > 0 && (
                <ClickStop className="mt-1">
                  <Button render={<Link href={reviewHref} />} nativeButton={false} variant="outline" size="sm">
                    Revisar ahora
                  </Button>
                </ClickStop>
              )}
            </CardContent>
          </AgentCard>
          <AgentCard storeId={active.id} storeName={storeName}>
            <CardContent className="flex flex-col gap-2 p-4">
              <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <TrendingUp className="size-3.5 text-primary" aria-hidden /> Cierran el loop
              </span>
              <span className="flex items-start gap-2 text-[13px]">
                <Send className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <strong>Mensajero</strong> envía solo lo que aprobaste, nada sin tu permiso.
                  <span className="block text-xs text-muted-foreground">
                    {dispatcherRun?.status === "running" ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />
                        enviando ahora mismo…
                      </span>
                    ) : (
                      <>
                        {dispatched > 0 ? `${dispatched} enviadas` : "aún sin envíos"}
                        {approved > 0 ? ` · ${approved} aprobadas en cola` : ""}
                        {dispatcherRun?.summary ? ` · ${dispatcherRun.summary}` : ""}
                      </>
                    )}
                  </span>
                </span>
              </span>
              <span className="flex items-start gap-2 text-[13px]">
                <TrendingUp className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <strong>Analista</strong> mide si volvieron y cuánta plata recuperaste.
                  <span className="block text-xs text-muted-foreground">{runLine(analystRun, "sin mediciones todavía")}</span>
                </span>
              </span>
            </CardContent>
          </AgentCard>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Tus 5 de hoy</h2>
          <span className="text-xs text-muted-foreground">
            {atRisk > 0 ? (
              <>
                {atRisk} en la mira · redacta y pasan a{" "}
                <Link href={reviewHref} className="underline">
                  Review
                </Link>
              </>
            ) : (
              "sin pendientes"
            )}
          </span>
        </div>
        <Card>
          <CardContent className="p-0">
            {attention.length === 0 ? (
              bgRunning(["scout", "strategist"]) ? (
                <div className="p-4">
                  <SectionLoading label="clientes en la mira" rows={2} />
                </div>
              ) : masivos > 0 ? (
                <p className="p-4 text-[13px] text-muted-foreground">
                  Tu mira son solo inactivos antiguos: van con reactivación masiva,
                  no 1-a-1.
                </p>
              ) : (
                <p className="p-4 text-[13px] text-muted-foreground">
                  Todo al día — ningún cliente vencido. Tu equipo IA sigue vigilando.
                </p>
              )
            ) : (
              <>
                <AttentionTable rows={attention} currency={viewCurrency} />
                {masivos > 0 && (
                  <p className="px-4 pb-4 text-xs text-muted-foreground tabular-nums">
                    +{masivos} inactivos antiguos van con reactivación masiva, no 1-a-1.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {(duplicateCount > 0 || enrichPending > 0) && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium">Salud de datos</h2>
            <span className="text-xs text-muted-foreground">para que el equipo IA trabaje con datos limpios</span>
          </div>
          <Card>
            <CardContent className="flex flex-col gap-2 p-4">
              {duplicateCount > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[13px]">
                    <strong>{duplicateCount}</strong>{" "}
                    {duplicateCount === 1 ? "email duplicado" : "emails duplicados"}: el mismo
                    contacto en más de una ficha parte el historial y el RFM.
                  </p>
                  <Button render={<Link href="/customers/duplicates" />} nativeButton={false} size="sm">
                    Revisar duplicados
                  </Button>
                </div>
              )}
              {enrichPending > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[13px]">
                    <strong>{enrichPending}</strong>{" "}
                    {enrichPending === 1 ? "dominio sin enriquecer" : "dominios sin enriquecer"}: sin
                    empresa e industria el Estratega y el Redactor trabajan a ciegas.
                  </p>
                  <Button render={<Link href="/customers" />} nativeButton={false} size="sm">
                    Enriquecer en Customers
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      <details className="text-[13px]">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          Cómo va el motor (detalle técnico)
        </summary>
        <Card className="mt-2">
          <CardContent className="flex flex-col gap-2 p-4">
            <p className="tabular-nums">
              <strong>{open}</strong> <span className="text-muted-foreground">detectadas</span>
              {" → "}<strong>{prioritized}</strong> <span className="text-muted-foreground">priorizadas</span>
              {" → "}<strong>{pending}</strong> <span className="text-muted-foreground">borradores</span>
              {" → "}<strong>{approved}</strong> <span className="text-muted-foreground">aprobadas</span>
              {" → "}<strong>{dispatched}</strong> <span className="text-muted-foreground">enviadas</span>
              {" → "}<strong>{converted}</strong> <span className="text-muted-foreground">recuperadas</span>
            </p>
            {runs.length > 0 && (
              <div className="flex flex-col gap-1">
                {runs.slice(0, 4).map((r, i) => (
                  <p key={`${r.kind}-${r.started_at}-${i}`} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{r.label}</span> · {r.status}
                    {r.summary ? ` · ${r.summary}` : ""}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </details>
    </div>
  );
}
