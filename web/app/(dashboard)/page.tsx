import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { countDuplicateEmails } from "@/lib/duplicates";
import { pendingDomains } from "@/lib/enrich";
import { formatMoney } from "@/lib/medusa";
import { resolveTenantCycleDays } from "@/lib/store-profiles";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { getRitmoSummary, type RitmoSummary } from "@/lib/customers-db";
import { applyScopeFilter, displayMarket, resolveMarketScope, withMarketParam, type MarketScope } from "@/lib/markets";
import {
  displayStoreName,
  getActiveStore,
  type TenantStore,
} from "@/lib/tenant";
import { AgentCard } from "./ask-agent";
import { TeamPulse } from "./team-pulse";
import { AttentionTable, type AttentionItem } from "./attention-table";
import { HoyHeroActions } from "./hoy-hero-actions";
import { FinanceStrip } from "./finance-strip";
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
import { avgTicket, getRankedMira } from "@/lib/mira";

export const instant = false;

type StoreRow = TenantStore;

type AttentionRow = AttentionItem;

interface RunRow {
  kind: string;
  label: string;
  status: string;
  summary: string | null;
  started_at: string;
  pulseState: "needs" | "active" | "paused" | null;
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
 *  Acepta también retention:v1 "sin comprar hace 38d (ciclo ~30d, vuelve típicamente entre 25–37d)".
 *  Chequeo de contradicción: si lleva 10× su ciclo sin comprar, el ciclo ya no
 *  es creíble y decir "suele volver cada 2d" es absurdo. */
function humanReason(raw: string | null, fallbackKind: string): string {
  if (!raw) return fallbackKind;
  const m =
    raw.match(/sin comprar hace (\d+)d \(media (\d+)d/i) ??
    raw.match(/sin comprar hace (\d+)d \(ciclo ~(\d+)d/i);
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

/** Fila del mapa Ritmo × Ventana: conteo + $ y barra apilada
 *  (pasó / en ventana / entra). SVG a mano, sin dependencias. */
function RitmoRow({
  noun,
  href,
  bucket,
  money,
}: {
  noun: string;
  href: string;
  bucket: { n: number; valorMinor: number; pasado: { n: number }; enVentana: { n: number }; entra: { n: number } };
  money: (n: number) => string;
}) {
  const label = noun === "con ritmo" ? "Con ritmo" : "Primera recompra";
  const segs = [
    { key: "pasaron", n: bucket.pasado.n, cls: "fill-amber-500/80" },
    { key: "en ventana", n: bucket.enVentana.n, cls: "fill-emerald-500/70" },
    { key: "entran", n: bucket.entra.n, cls: "fill-primary/40" },
  ];
  const W = 300;
  let x = 0;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[13px] tabular-nums">
        <Link href={href} className="underline">
          {bucket.n} {noun}
        </Link>{" "}
        · {money(bucket.valorMinor)} en juego
      </p>
      {bucket.n > 0 && (
        <>
          <svg
            viewBox={`0 0 ${W} 10`}
            className="w-full"
            role="img"
            aria-label={`${label}: ${segs.map((s) => `${s.n} ${s.key}`).join(", ")}`}
          >
            {segs.map((s) => {
              const w = bucket.n > 0 ? Math.max(s.n > 0 ? 2 : 0, (s.n / bucket.n) * W) : 0;
              const el = (
                <rect key={s.key} x={x} y={0} width={w} height={10} rx={2} className={s.cls}>
                  <title>{`${s.n} ${s.key}`}</title>
                </rect>
              );
              x += w;
              return el;
            })}
          </svg>
          <p className="text-xs text-muted-foreground tabular-nums">
            {segs.map((s) => `${s.n} ${s.key}`).join(" · ")}
          </p>
        </>
      )}
    </div>
  );
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
  let financeBuckets: MonthBucket[] = [];
  let financeKpis: FinanceKpis | null = null;
  let rescate: ReturnType<typeof rescateMonthly> = null;
  let cycleDays: number | null = null;
  let retention: RetentionKpis | null = null;
  let hoyActuar = 0;
  let hoyVigilar = 0;
  let hoyAuto = 0;
  // Foto del día del motor por cliente (héroe, fila, "No tocamos", Finanzas).
  const predByCust = new Map<
    string,
    {
      decision: string;
      t: number | null;
      p25: number | null;
      p75: number | null;
      p: number | null;
      ticket: number | null;
      valor: number | null;
      currency: string | null;
      confidence: string | null;
      asOf: string | null;
    }
  >();
  let hoyValor = 0;
  let hoyLow = 0;
  let hoyHigh = 0;
  let hoyForeign: Array<{ code: string; n: number; value: number }> = [];
  const hoyGroups = { organico: 0, dormido: 0, contactado_reciente: 0, sin_canal: 0 };
  let nextWindowDate: string | null = null;
  // Fecha de la foto del día: si es anterior a hoy, se avisa (sin cron diario
  // garantizado, la frescura se declara en vez de asumirse).
  let fotoVieja = false;
  let juegoMinor = 0;
  let juegoLow = 0;
  let juegoHigh = 0;
  let juegoCount = 0;
  let hasJuego = false;
  let ritmo: RitmoSummary | null = null;
  let team: TeamProfile = { vertical: null, buyerType: null, cycle: null, archetype: null, confidence: null, learnedAt: null };
  // Filtro global por país/mercado (?market= del header). Lo que se filtra es
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
      (async () => {
        // pulse_state es nuevo (migración 20261019000000): fallback sin ella
        // en DBs aún no migradas.
        const withPulse = await db
          .from("background_runs")
          .select("kind,label,status,summary,started_at,pulse_state")
          .eq("store_id", active.id)
          .order("started_at", { ascending: false })
          .limit(10);
        if (!withPulse.error) return withPulse;
        return db
          .from("background_runs")
          .select("kind,label,status,summary,started_at")
          .eq("store_id", active.id)
          .order("started_at", { ascending: false })
          .limit(10);
      })(),
      db
        .from("store_profiles")
        .select("vertical_detected,buyer_type,repurchase_cycle_days,archetype,interpretation_confidence,interpreted_at")
        .eq("store_id", active.id)
        .maybeSingle(),
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

    const tenantCycleDays = await resolveTenantCycleDays(active.id).catch(() => null);

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
    // Valor = predicción del motor cuando existe (nunca scores crudos en UI).
    const { rows: pool, foreign } = await getRankedMira(active.id, 100, {
      ...scope,
      currency: scope.market?.currency?.toUpperCase() ?? null,
    });
    const miraValorDe = (a: { valorEsperadoMinor?: number | null }): number =>
      a.valorEsperadoMinor ?? 0;
    // Hoy = solo accionable 1-a-1 (decisión del motor o, sin predicción,
    // antigüedad ≤365d), tope 5 ("tus 5 de hoy").
    // La masa antigua no se lista fila por fila: va con reactivación masiva.
    // El resto espera en Review (inbox): el dashboard no satura.
    const actionable = pool.filter(
      (a) =>
        a.decision === "actuar" ||
        a.decision === "revision_humana" ||
        (a.decision == null && (a.daysSince ?? 0) <= 365),
    );
    attention = actionable.slice(0, 5).map(
      (r): AttentionRow => {
        const pred = predByCust.get(r.customerDbId) ?? null;
        return {
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
          draftStatus: r.draftStatus,
          decision: pred?.decision ?? r.decision ?? null,
          tDays: pred?.t ?? null,
          p25Days: pred?.p25 ?? null,
          p75Days: pred?.p75 ?? null,
          pRecompraH: pred?.p ?? r.pRecompraH ?? null,
          ticketEsperadoMinor: pred?.ticket ?? null,
          predCurrency: pred?.currency ?? null,
          confidence: pred?.confidence ?? null,
        };
      },
    );
    masivos = pool.length - actionable.length;
    // Puerta de entrada del funnel: el #1 con el criterio único (sea insignia o no).
    topLead = attention[0] ?? null;
    miraValue = pool.reduce((acc, a) => acc + miraValorDe(a), 0);
    // Otras monedas: conteo y valor aparte, nunca sumados a los S/.
    {
      const byCur = new Map<string, { n: number; value: number }>();
      for (const f of foreign) {
        const code = (f.currency ?? "?").toUpperCase();
        const g = byCur.get(code) ?? { n: 0, value: 0 };
        g.n += 1;
        g.value += miraValorDe(f);
        byCur.set(code, g);
      }
      foreignLines = [...byCur.entries()].map(([code, g]) => ({ code, n: g.n, value: g.value }));
    }

    // Hoy desde el motor probabilístico (lectura del día, sin mezclar monedas
    // porque son conteos, no sumas; los montos solo agregan intra-moneda).
    try {
      const dayStart = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
      ).toISOString();
      let predRows: Array<Record<string, unknown>> = [];
      {
        const { data } = await db
          .from("customer_predictions")
          .select(
            "customer_id,decision,valor_esperado_minor,p_low,p_high,ticket_esperado_minor,currency,p_recompra_h,p25_days,p75_days,confidence,as_of,evidence_json",
          )
          .eq("store_id", active.id)
          .gte("as_of", dayStart)
          .limit(5000);
        predRows = (data ?? []) as Array<Record<string, unknown>>;
      }
      if (predRows.length === 0) {
        const { data } = await db
          .from("customer_predictions")
          .select(
            "customer_id,decision,valor_esperado_minor,p_low,p_high,ticket_esperado_minor,currency,p_recompra_h,p25_days,p75_days,confidence,as_of,evidence_json",
          )
          .eq("store_id", active.id)
          .order("as_of", { ascending: false })
          .limit(5000);
        // Solo la fecha más reciente (una foto, no historia).
        const rowsAll = (data ?? []) as Array<Record<string, unknown>>;
        const maxAsOf = rowsAll.length > 0 ? String(rowsAll[0].as_of ?? "") : null;
        predRows = maxAsOf ? rowsAll.filter((r) => String(r.as_of ?? "") === maxAsOf) : [];
        if (maxAsOf && maxAsOf < dayStart) fotoVieja = true;
      }
      const viewCur = scope.market?.currency?.toUpperCase() ?? active.shop_currency;
      const foreign = new Map<string, { n: number; value: number }>();
      let nextIn: number | null = null;
      for (const r of predRows) {
        const d = String(r.decision ?? "");
        if (d === "actuar" || d === "revision_humana") hoyActuar += 1;
        else if (d === "vigilar") hoyVigilar += 1;
        else hoyAuto += 1;
        if (d === "organico") hoyGroups.organico += 1;
        else if (d === "dormido") hoyGroups.dormido += 1;
        else if (d === "contactado_reciente") hoyGroups.contactado_reciente += 1;
        else if (d === "sin_canal") hoyGroups.sin_canal += 1;
        const cid = String(r.customer_id ?? "");
        const ev = (r.evidence_json as Record<string, unknown> | null) ?? {};
        const t = ev.t_days == null ? null : Number(ev.t_days);
        const entry = {
          decision: d,
          t,
          p25: r.p25_days == null ? null : Number(r.p25_days),
          p75: r.p75_days == null ? null : Number(r.p75_days),
          p: r.p_recompra_h == null ? null : Number(r.p_recompra_h),
          ticket: r.ticket_esperado_minor == null ? null : Number(r.ticket_esperado_minor),
          valor: r.valor_esperado_minor == null ? null : Number(r.valor_esperado_minor),
          currency: (r.currency as string | null) ?? null,
          confidence: (r.confidence as string | null) ?? null,
          asOf: (r.as_of as string | null) ?? null,
        };
        if (cid) predByCust.set(cid, entry);
        // Σ solo intra-moneda (nunca PEN+MXN); el resto va en línea aparte.
        const cur = (r.currency as string | null) ?? null;
        const inView =
          viewCur === null || cur === null || cur.toUpperCase() === viewCur.toUpperCase();
        const v = r.valor_esperado_minor == null ? null : Number(r.valor_esperado_minor);
        const tk = r.ticket_esperado_minor == null ? null : Number(r.ticket_esperado_minor);
        if (d === "actuar" || d === "revision_humana") {
          if (v !== null && tk !== null) {
            if (inView) {
              hoyValor += v;
              hoyLow += Number(r.p_low ?? 0) * tk;
              hoyHigh += Number(r.p_high ?? 0) * tk;
            } else {
              const code = (cur ?? "?").toUpperCase();
              const g = foreign.get(code) ?? { n: 0, value: 0 };
              g.n += 1;
              g.value += v;
              foreign.set(code, g);
            }
          } else if (v !== null && !inView) {
            const code = (cur ?? "?").toUpperCase();
            const g = foreign.get(code) ?? { n: 0, value: 0 };
            g.n += 1;
            g.value += v;
            foreign.set(code, g);
          }
        }
        // En juego (Finanzas): actuar + vigilar, intra-moneda.
        if ((d === "actuar" || d === "revision_humana" || d === "vigilar") && inView && v !== null) {
          hasJuego = true;
          juegoMinor += v;
          juegoCount += 1;
          if (tk !== null) {
            juegoLow += Number(r.p_low ?? 0) * tk;
            juegoHigh += Number(r.p_high ?? 0) * tk;
          }
        }
        // Próximo en entrar a ventana: vigilar con (p25 - t) futuro mínimo.
        if (d === "vigilar" && entry.p25 !== null && t !== null) {
          const diff = entry.p25 - t;
          if (diff > 0 && (nextIn === null || diff < nextIn)) nextIn = diff;
        }
      }
      hoyForeign = [...foreign.entries()].map(([code, g]) => ({ code, n: g.n, value: g.value }));
      if (nextIn !== null) {
        const dt = new Date(Date.now() + Math.ceil(nextIn) * 86_400_000);
        nextWindowDate = dt.toISOString().slice(0, 10);
      }
    } catch {
      // Sin tabla/migración aún: se omite el conteo "Hoy", el resto sigue.
    }
    // La base en 3 ritmos (conteos + $ en juego, sin mezclar monedas).
    try {
      ritmo = await getRitmoSummary(
        active.id,
        scope.market?.currency?.toUpperCase() ?? active.shop_currency,
      );
    } catch {
      ritmo = null;
    }

    runs = ((runRows.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      kind: String(r.kind ?? ""),
      label: String(r.label ?? ""),
      status: String(r.status ?? ""),
      summary: (r.summary as string | null) ?? null,
      started_at: String(r.started_at ?? ""),
      pulseState: (["needs", "active", "paused"] as const).includes(
        r.pulse_state as "needs" | "active" | "paused",
      )
        ? (r.pulse_state as "needs" | "active" | "paused")
        : null,
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
  const hasMotor = hoyActuar + hoyVigilar + hoyAuto > 0;
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

  const learnedAgo = ago(team.learnedAt);
  const needsRecheck =
    team.learnedAt != null && Date.now() - Date.parse(team.learnedAt) > 30 * 86_400_000;

  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold tracking-tight">
            {hasMotor
              ? hoyActuar > 0
                ? `Hola, ${storeName} — hoy tienes ${hoyActuar} para actuar`
                : `Todo al día, ${storeName}`
              : atRisk > 0
                ? `Hola, ${storeName} — hoy tienes ${atRisk} ${atRisk === 1 ? "cliente" : "clientes"} por recuperar`
                : `Todo al día, ${storeName}`}
          </h1>
          <span className="text-xs text-muted-foreground">
            {hasMotor
              ? hoyActuar > 0
                ? `${hoyVigilar} en vigilancia · ${hoyAuto} en automático`
                : pending > 0
                  ? `Nada nuevo que detectar; ${pending} por tu visto bueno en Review.`
                  : "Ningún mensaje necesario hoy; la vigilancia sigue."
              : atRisk > 0
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

      {(hoyActuar + hoyVigilar + hoyAuto > 0) && (
        <section aria-label="Hoy">
          <Card>
            <CardContent className="flex flex-col gap-3 p-5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Hoy · {storeName}
                {cycleDays !== null ? ` (ciclo ~${cycleDays}d)` : ""}
              </span>
              {fotoVieja && (
                <p className="text-xs text-muted-foreground">
                  Predicciones de ayer: se actualizan con la próxima corrida del motor.
                </p>
              )}
              {hoyActuar > 0 ? (
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-3xl font-semibold tabular-nums">{hoyActuar}</span>
                  <span className="text-[15px]">para actuar hoy</span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {money(hoyValor)} en juego
                  </span>
                </div>
              ) : pending > 0 ? (
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-3xl font-semibold tabular-nums">{pending}</span>
                  <span className="text-[15px]">
                    borrador{pending === 1 ? "" : "es"} por tu visto bueno
                  </span>
                </div>
              ) : (
                <p className="text-[15px]">Al día — nadie necesita un mensaje.</p>
              )}
              <p className="text-xs text-muted-foreground tabular-nums">
                {hoyActuar > 0 ? (
                  <>
                    {hoyVigilar} vigilando · {hoyAuto} en automático · entre {money(hoyLow)} y {money(hoyHigh)}
                    {hoyForeign.map((fl) => (
                      <span key={fl.code}>
                        {" "}+{fl.n} en {fl.code} ({formatMoney(Math.round(fl.value), fl.code)})
                      </span>
                    ))}
                  </>
                ) : (
                  <>
                    {hoyVigilar} en vigilancia
                    {nextWindowDate ? ` · el próximo entra en ventana el ${nextWindowDate}` : ""}
                  </>
                )}
              </p>
              <span className="flex flex-wrap items-center gap-2">
                {hoyActuar > 0 ? (
                  <HoyHeroActions
                    actuarCount={hoyActuar}
                    isB2B={team.archetype === "b2b_proyecto" || team.archetype === "b2b_recurrente"}
                    reviewHref={reviewHref}
                  />
                ) : pending > 0 ? (
                  <Button render={<Link href={reviewHref} />} nativeButton={false} size="sm">
                    Revisar en Review
                  </Button>
                ) : null}
                <Button
                  render={<Link href={withMarketParam("/customers?decision=vigilar", scope.market?.id ?? null)} />}
                  nativeButton={false}
                  variant="outline"
                  size="sm"
                >
                  Ver vigilando
                </Button>
              </span>
            </CardContent>
          </Card>
        </section>
      )}
      <section id="hoy-tabla">
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
            ) : pending > 0 ? (
              <>
                en Review con borrador ·{" "}
                <Link href={reviewHref} className="underline">
                  revisar ahora
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
              ) : pending > 0 ? (
                <p className="p-4 text-[13px] text-muted-foreground">
                  Los de hoy ya tienen borrador: están en{" "}
                  <Link href={reviewHref} className="underline">
                    Review
                  </Link>{" "}
                  esperando tu aprobación.
                </p>
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
        {(hoyGroups.organico + hoyGroups.dormido + hoyGroups.contactado_reciente + hoyGroups.sin_canal > 0) && (
          <details className="mt-2 rounded-lg border px-4 py-3">
            <summary className="cursor-pointer text-[13px] font-medium hover:text-foreground">
              No tocamos hoy ({hoyGroups.organico + hoyGroups.dormido + hoyGroups.contactado_reciente + hoyGroups.sin_canal})
            </summary>
            <p className="mt-1 text-xs text-muted-foreground">
              El motor también decide a quién NO escribir: esto ahorra mensajes y descuentos.
            </p>
            <ul className="mt-2 flex flex-col gap-1 text-[13px] tabular-nums">
              <li>
                {hoyGroups.organico} volverán solos ·{" "}
                <Link href={withMarketParam("/customers?decision=organico", scope.market?.id ?? null)} className="underline">
                  ver
                </Link>
              </li>
              <li>
                {hoyGroups.dormido} dormidos (se re-evalúan solos) ·{" "}
                <Link href={withMarketParam("/customers?decision=dormido", scope.market?.id ?? null)} className="underline">
                  ver
                </Link>
              </li>
              <li>
                {hoyGroups.contactado_reciente} contactados hace poco ·{" "}
                <Link href={withMarketParam("/customers?decision=contactado_reciente", scope.market?.id ?? null)} className="underline">
                  ver
                </Link>
              </li>
              <li>
                {hoyGroups.sin_canal} sin canal utilizable ·{" "}
                <Link href={withMarketParam("/customers?decision=sin_canal", scope.market?.id ?? null)} className="underline">
                  ver
                </Link>
              </li>
            </ul>
          </details>
        )}
      </section>


      {ritmo && (ritmo.conRitmo.n + ritmo.primera.n + ritmo.sinCompras > 0) && (
        <section aria-label="La base">
          <Card>
            <CardContent className="flex flex-col gap-3 p-4">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                La base · por ritmo de recompra
              </span>
              <RitmoRow
                noun="con ritmo"
                href={withMarketParam("/customers?ritmo=con-ritmo", scope.market?.id ?? null)}
                bucket={ritmo.conRitmo}
                money={money}
              />
              <RitmoRow
                noun="en primera recompra"
                href={withMarketParam("/customers?ritmo=primera", scope.market?.id ?? null)}
                bucket={ritmo.primera}
                money={money}
              />
              <p className="text-[13px] text-muted-foreground tabular-nums">
                <Link href={withMarketParam("/customers?ritmo=sin-compras", scope.market?.id ?? null)} className="underline">
                  {ritmo.sinCompras} sin compras
                </Link>{" "}
                · el motor aún no los ve
              </p>
            </CardContent>
          </Card>
        </section>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Por recuperar
            </span>
            <span className="text-2xl font-semibold tabular-nums tracking-tight">
              {hasMotor ? hoyActuar : atRisk}
            </span>
            <span className="text-xs text-muted-foreground">
              {hasMotor
                ? `para actuar hoy · ${hoyVigilar} en vigilancia`
                : buyers > 0
                  ? `${riskPct}% de tus ${buyers} compradores`
                  : "conecta y sincroniza para empezar"}
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
                  {money(avgTicket(topLead.totalSpent, topLead.ordersCount))} ticket).
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
          enJuegoProb={
            hasJuego
              ? { minor: Math.round(juegoMinor), low: Math.round(juegoLow), high: Math.round(juegoHigh), count: juegoCount }
              : null
          }
          organicosEnAuto={hoyGroups.organico}
        />
      )}

      <section aria-label="Tu equipo IA">
        <AgentCard storeId={active.id} storeName={storeName}>
          <TeamPulse
            teamVertical={team.vertical}
            teamCycle={team.cycle}
            teamConfidence={team.confidence}
            learnedAgo={learnedAgo}
            needsRecheck={needsRecheck}
            totalVigilados={hoyActuar + hoyVigilar + hoyAuto}
            hoyActuar={hoyActuar}
            hoyVigilar={hoyVigilar}
            hasMotor={hasMotor}
            atRisk={atRisk}
            topLeadName={topLead?.name ?? null}
            pending={pending}
            approved={approved}
            dispatched={dispatched}
            leadsPending={leadsPending}
            converted={converted}
            recoveredLabel={money(revenue)}
            reviewHref={reviewHref}
            leadsHref={withMarketParam("/review?tab=leads", scope.market?.id ?? null)}
            settingsHref="/settings"
            lastActionAgo={runs.length > 0 ? (ago(runs[0].started_at) ?? null) : null}
            runAgos={{
              scout: scoutRun ? (ago(scoutRun.started_at) ?? null) : null,
              strategist: strategistRun ? (ago(strategistRun.started_at) ?? null) : null,
              copywriter: copywriterRun ? (ago(copywriterRun.started_at) ?? null) : null,
              prospect: prospectRun ? (ago(prospectRun.started_at) ?? null) : null,
              dispatcher: dispatcherRun ? (ago(dispatcherRun.started_at) ?? null) : null,
              analyst: analystRun ? (ago(analystRun.started_at) ?? null) : null,
            }}
            pulseStates={{
              scout: scoutRun?.pulseState ?? null,
              strategist: strategistRun?.pulseState ?? null,
              copywriter: copywriterRun?.pulseState ?? null,
              prospect: prospectRun?.pulseState ?? null,
              dispatcher: dispatcherRun?.pulseState ?? null,
              analyst: analystRun?.pulseState ?? null,
            }}
          />
        </AgentCard>
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
