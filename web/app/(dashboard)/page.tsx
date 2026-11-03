import Link from "next/link";
import {
  ChevronDown,
  Mail,
  MessageCircle,
  PenLine,
  Radar,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { SectionHeading } from "@/components/section-heading";
import { HealthSection } from "@/components/health-section";
import { countDuplicateEmails } from "@/lib/duplicates";
import { pendingDomains } from "@/lib/enrich";
import { formatMoney, formatNumber, formatPercentPoints } from "@/lib/format";
import { getStoreProfile, resolveTenantCycleDays } from "@/lib/store-profiles";
import { readConnections } from "@/lib/store";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { applyScopeFilter, resolveMarketScope, withMarketParam, type MarketScope } from "@/lib/markets";
import {
  displayStoreName,
  getMyActiveStore,
  getMyStoreIds,
  type TenantStore,
} from "@/lib/tenant";
import { TeamPulse } from "./team-pulse";
import { AutoRefresh } from "@/components/auto-refresh";
import { DECISION_COPY } from "@/lib/decision-copy";
import { type AttentionItem } from "./attention-table";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { avgTicket, getRankedMira } from "@/lib/mira";
import { HORIZON_BY_ARCHETYPE } from "@/lib/retention-model";
import { approverLabel, dispatchedOutcome } from "@/lib/action-trace";
import { connection } from "next/server";

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

/** "sin comprar hace 86d (ciclo ~60d, vuelve típicamente entre 108–208d)" →
 *  "Hace 86 días que no pauta · suele volver entre los 108–208d".
 *  Usa la ventana personal (la que decide), no el ciclo de la tienda: mostrar
 *  "cada 60d" junto a "108–208d" contradice la fila. Verbo según tenant
 *  (pauta en servicio/digital, compra en el resto).
 *  Chequeo de contradicción: si lleva 10× su ciclo sin comprar, el ciclo ya no
 *  es creíble y decir "suele volver cada 2d" es absurdo. */
function humanReason(raw: string | null, verb: string, fallbackKind: string): string {
  if (!raw) return fallbackKind;
  const no = verb === "pauta" ? "no pauta" : "no compra";
  const since = raw.match(/sin comprar hace (\d+)d/i);
  const win = raw.match(/vuelve t[ií]picamente entre (\d+)[–-](\d+)d/i);
  if (since && win) {
    return `Hace ${formatNumber(Number(since[1]))} días que ${no} · suele volver entre los ${formatNumber(Number(win[1]))}–${formatNumber(Number(win[2]))}d`;
  }
  const m =
    raw.match(/sin comprar hace (\d+)d \(media (\d+)d/i) ??
    raw.match(/sin comprar hace (\d+)d \(ciclo ~(\d+)d/i);
  if (m) {
    const s = Number(m[1]);
    const cycle = Math.max(1, Number(m[2]));
    if (s > 10 * cycle)
      return `Hace ${formatNumber(Number(m[1]))} días que ${no} · sin ritmo detectable de recompra`;
    return `Hace ${formatNumber(Number(m[1]))} días que ${no} · suele volver cada ${formatNumber(Number(m[2]))}d`;
  }
  return raw;
}

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${formatNumber(min)} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${formatNumber(h)} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "ayer";
  if (d < 30) return `hace ${formatNumber(d)} días`;
  return `hace ${formatNumber(Math.floor(d / 30))} meses`;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; market?: string }>;
}) {
  // Request-time: la page usa Date.now()/new Date() (ago, weekAgoIso,
  // dayStart, nextWindowDate, needsRecheck) y Cache Components no lo difiere
  // con `instant = false` — sin esto, el prerender falla con
  // blocking-prerender-current-time. El connection() del layout no cubre
  // a la page (cada segmento se valida por separado).
  await connection();
  const dbReady = isSupabaseConfigured();
  const sp = await searchParams;

  if (!dbReady) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <AppCardState>
          Supabase no configurado (`supabase start` + `web/.env.local`).
        </AppCardState>
      </div>
    );
  }

  const db = getSupabase();
  let stores: StoreRow[] = [];
  let active: StoreRow | null = null;
  let storesError: string | null = null;
  try {
    const resolved = await getMyActiveStore(sp.store);
    stores = resolved.stores;
    active = resolved.active;
  } catch (e) {
    storesError = e instanceof Error ? e.message : "DB read failed";
  }
  if (storesError) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <AppCardState>
          Stores read: {storesError}
        </AppCardState>
      </div>
    );
  }
  if (stores.length === 0 || !active) {
    // Sin tiendas visibles: o aún no hay sync, o el user no tiene membresía.
    // Se distingue para no mandar a Settings a quien solo necesita alta en
    // `merchant_users` (ver `docs/coolify.md` §5 / migración bootstrap).
    const myIds = await getMyStoreIds().catch(() => null);
    const noAccess = Array.isArray(myIds) && myIds.length === 0;
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <AppCard
          footer={
            noAccess ? undefined : (
              <Button render={<Link href="/settings" />} nativeButton={false} variant="outline" size="sm">
                Ir a Settings
              </Button>
            )
          }
        >
          {noAccess
            ? "Tu usuario no tiene tiendas asignadas. Pide a tu admin que te agregue en merchant_users."
            : "Conecta tu tienda para empezar a recuperar clientes."}
        </AppCard>
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
  // Valor en juego por etapa del embudo (borrador/aprobados): Σ valor
  // esperado de sus clientes. Sin esto el funnel muestra plata solo en los
  // extremos y las etapas intermedias no se pueden comparar.
  let valorBorrador = 0;
  let valorAprobados = 0;
  let topLead: AttentionRow | null = null;
  let foreignLines: Array<{ code: string; n: number; value: number }> = [];
  let cycleDays: number | null = null;
  let hoyActuar = 0;
  let hoyVigilar = 0;
  let hoyAuto = 0;
  // Issue #21 Paso 1 (solo display): vigilar partido en cercano vs residual.
  // Cercano = decision==vigilar AND (recuperable OR p>=corte_tenant).
  let hoyCercano = 0;
  let hoyResidual = 0;
  let closeWatchP = 0.1;
  // Issue #14 B2: el héroe sumaba plata sin descontar estimaciones débiles.
  // Se cuenta aparte y se declara en el subtítulo (no se descuenta en
  // silencio: el dueño decide si actuar igual).
  let hoyDebiles = 0;
  // Analista: "con pocos datos" también en seguimiento cercano (no solo
  // actuar): una partición chica (MX, n=4) declara confidence=baja y el
  // héroe no debe mostrarla como cercana sin advertencia. Solo display.
  let hoyDebilesCercano = 0;
  // Foto del día del motor por cliente (héroe, fila, "No tocamos", Finanzas).
  const predByCust = new Map<
    string,
    {
      decision: string;
      t: number | null;
      p25: number | null;
      p75: number | null;
      p: number | null;
      bandaP: string | null;
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
  // Verbo del tenant para motivos ("pauta" en servicio/digital, "compra" en
  // el resto): la fila de Hoy no puede hablar como bodega en TuPantalla.
  let purchaseVerb = "compra";
  // Issue #19 Paso 3: últimos enviados (feed "¿volvieron?").
  let sentFeed: Array<{
    id: string; customerId: string; name: string; email: string; channel: string; body: string;
    approvedBy: string | null; dispatchedAt: string | null; revenue: number | null;
  }> = [];
  let team: TeamProfile = { vertical: null, buyerType: null, cycle: null, archetype: null, confidence: null, learnedAt: null };
  // Filtro global por país/mercado (?market= del header). Lo que se filtra es
  // el contenido operativo: conteos, mira, revenue y órdenes.
  let scope: MarketScope = { market: null, countries: null, customerIds: null };
  // Aviso de configuración indispensable (tienda + negocio). Sin tienda no
  // hay sync; sin perfil el motor usa genéricos. Se muestra arriba del todo.
  let tiendaMissing = false;
  let negocioMissing = false;
  try {
    const connections = await readConnections().catch(() => null);
    tiendaMissing = !connections?.medusaUrl || !connections?.medusaToken;
  } catch {
    tiendaMissing = false;
  }

  try {
    scope = await resolveMarketScope(active.id, sp.market).catch(() => scope);
    const weekAgoIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
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
      actRows,
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
      // Clientes con borrador/aprobado (para plata por etapa del embudo).
      (async () => {
        try {
          const q = applyScopeFilter(
            db
              .from("proposed_actions")
              .select("customer_id,status")
              .eq("store_id", active.id)
              .in("status", ["pending_review", "approved"]),
            scope,
          );
          const { data } = await q.limit(500);
          return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
            cid: String(r.customer_id ?? ""),
            st: String(r.status ?? ""),
          }));
        } catch {
          return [] as Array<{ cid: string; st: string }>;
        }
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
    try {
      const prof = await getStoreProfile(active.id).catch(() => null);
      if (prof?.catalogType === "servicio" || prof?.catalogType === "digital") purchaseVerb = "pauta";
    } catch {
      // Sin perfil: se queda "compra".
    }

    // Ciclo del tenant para el héroe Hoy y TeamPulse (la salud 12m vive en /finanzas).
    cycleDays = tenantCycleDays;

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
    // antigüedad ≤365d), tope 5.
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
          reason: humanReason(r.reason, purchaseVerb, r.kind),
          daysSince: r.daysSince,
          email: r.email,
          name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
          ordersCount: r.ordersCount,
          totalSpent: r.totalSpent,
          draftStatus: r.draftStatus,
          contactability: r.contactability ?? null,
          decision: pred?.decision ?? r.decision ?? null,
          tDays: pred?.t ?? null,
          p25Days: pred?.p25 ?? null,
          p75Days: pred?.p75 ?? null,
          pRecompraH: pred?.p ?? r.pRecompraH ?? null,
          ticketEsperadoMinor: pred?.ticket ?? null,
          valorEsperadoMinor: r.valorEsperadoMinor ?? pred?.valor ?? null,
          predCurrency: pred?.currency ?? null,
          confidence: pred?.confidence ?? null,
        };
      },
    );
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
      // Corte por tenant de "seguimiento cercano" (issue #21 Paso 1, display).
      try {
        const { resolveCloseWatchP } = await import("@/lib/store-profiles");
        closeWatchP = await resolveCloseWatchP(active.id).catch(() => 0.1);
      } catch {
        closeWatchP = 0.1;
      }
      const { isCloseWatch: isCercano } = await import("@/lib/customer-predictions");
      let predRows: Array<Record<string, unknown>> = [];
      {
        const { data } = await db
          .from("customer_predictions")
          .select(
            "customer_id,decision,valor_esperado_minor,p_low,p_high,ticket_esperado_minor,currency,p_recompra_h,banda_p,p25_days,p75_days,confidence,as_of,model_version,evidence_json",
          )
          .eq("store_id", active.id)
          .gte("as_of", dayStart)
          .order("model_version", { ascending: false })
          .limit(5000);
        predRows = (data ?? []) as Array<Record<string, unknown>>;
      }
      if (predRows.length === 0) {
        const { data } = await db
          .from("customer_predictions")
          .select(
            "customer_id,decision,valor_esperado_minor,p_low,p_high,ticket_esperado_minor,currency,p_recompra_h,banda_p,p25_days,p75_days,confidence,as_of,model_version,evidence_json",
          )
          .eq("store_id", active.id)
          .order("as_of", { ascending: false })
          .order("model_version", { ascending: false })
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
      // v1+v2 conviven el día del deploy: un cliente, un voto (prefiere v2).
      const seenCust = new Set<string>();
      for (const r of predRows) {
        const cid0 = String(r.customer_id ?? "");
        if (!cid0 || seenCust.has(cid0)) continue;
        seenCust.add(cid0);
        const d = String(r.decision ?? "");
        // Con filtro de mercado el market es el universo también en conteos:
        // sin esto el héroe cuenta MX bajo el selector PE · PEN
        // mientras Finanzas suma solo PE (45 vs 44).
        const cur = (r.currency as string | null) ?? null;
        const inView =
          viewCur === null || cur === null || cur.toUpperCase() === viewCur.toUpperCase();
        if (scope.market && !inView) continue;
        if (d === "actuar" || d === "revision_humana") hoyActuar += 1;
        else if (d === "vigilar") {
          hoyVigilar += 1;
          const banda = (r.banda_p as string | null) ?? null;
          const p = r.p_recompra_h == null ? null : Number(r.p_recompra_h);
          const cercano = isCercano({ decision: d, bandaP: banda, pRecompraH: p }, closeWatchP);
          if (cercano) hoyCercano += 1;
          else hoyResidual += 1;
          if ((r.confidence as string | null) === "baja" && cercano) hoyDebilesCercano += 1;
        } else hoyAuto += 1;
        if ((r.confidence as string | null) === "baja" && (d === "actuar" || d === "revision_humana")) hoyDebiles += 1;
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
          bandaP: (r.banda_p as string | null) ?? null,
          ticket: r.ticket_esperado_minor == null ? null : Number(r.ticket_esperado_minor),
          valor: r.valor_esperado_minor == null ? null : Number(r.valor_esperado_minor),
          currency: (r.currency as string | null) ?? null,
          confidence: (r.confidence as string | null) ?? null,
          asOf: (r.as_of as string | null) ?? null,
        };
        if (cid) predByCust.set(cid, entry);
        // Σ solo intra-moneda (nunca PEN+MXN); el resto va en línea aparte.
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
    // Issue #14 B2: predByCust se llenaba DESPUÉS de mapear attention
    // (confidence=null en cada fila). Re-enriquecer aquí con la foto del día.
    if (predByCust.size > 0 && attention.length > 0) {
      attention = attention.map((row) => {
        const pred = predByCust.get(row.customerDbId) ?? null;
        if (!pred) return row;
        return {
          ...row,
          decision: pred.decision ?? row.decision ?? null,
          tDays: pred.t ?? row.tDays ?? null,
          p25Days: pred.p25 ?? row.p25Days ?? null,
          p75Days: pred.p75 ?? row.p75Days ?? null,
          pRecompraH: pred.p ?? row.pRecompraH ?? null,
          ticketEsperadoMinor: pred.ticket ?? row.ticketEsperadoMinor ?? null,
          valorEsperadoMinor: pred.valor ?? row.valorEsperadoMinor ?? null,
          predCurrency: pred.currency ?? row.predCurrency ?? null,
          confidence: pred.confidence ?? row.confidence ?? null,
        };
      });
      topLead = attention[0] ?? null;
    }
    // Plata por etapa del embudo con la foto del día (misma moneda de la vista).
    {
      const viewCur = scope.market?.currency?.toUpperCase() ?? active.shop_currency;
      for (const a of actRows) {
        if (!a.cid) continue;
        const pred = predByCust.get(a.cid) ?? null;
        const v = pred?.valor ?? null;
        if (v === null) continue;
        const cur = pred?.currency ?? null;
        if (viewCur !== null && cur !== null && cur.toUpperCase() !== viewCur.toUpperCase()) continue;
        if (a.st === "pending_review") valorBorrador += v;
        else if (a.st === "approved") valorAprobados += v;
      }
    }
    // Últimos enviados: 8 despachados recientes con su aprobador (Paso 3).
    // Fallback sin approved_by si la migración 20261022000000 aún no corrió:
    // el feed se muestra igual, con "sin registro".
    try {
      const feedSelect = (cols: string) =>
        applyScopeFilter(
          db.from("proposed_actions").select(cols).eq("store_id", active.id)
            .eq("status", "dispatched").not("dispatched_at", "is", null),
          scope,
        ).order("dispatched_at", { ascending: false }).limit(8);
      let feedRes = await feedSelect("id,customer_id,channel,body,approved_by,dispatched_at,revenue_attributed,customers(email,first_name,last_name)");
      if (feedRes.error) {
        feedRes = await feedSelect("id,customer_id,channel,body,dispatched_at,revenue_attributed,customers(email,first_name,last_name)");
      }
      if (!feedRes.error) {
        sentFeed = ((feedRes.data ?? []) as Array<Record<string, unknown>>).map((r) => {
          const c = (r.customers ?? {}) as Record<string, unknown>;
          return {
            id: String(r.id ?? ""),
            customerId: String(r.customer_id ?? ""),
            name: [c.first_name, c.last_name].filter(Boolean).join(" ") || String(c.email ?? ""),
            email: String(c.email ?? ""),
            channel: String(r.channel ?? ""),
            body: String(r.body ?? ""),
            approvedBy: (r.approved_by as string | null) ?? null,
            dispatchedAt: (r.dispatched_at as string | null) ?? null,
            revenue: r.revenue_attributed == null ? null : Number(r.revenue_attributed),
          };
        });
      }
    } catch {
      sentFeed = [];
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
    negocioMissing = !profileRow.data;
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

  // Ventana del analyst (H por arquetipo) para el feed de enviados.
  const analystWindowDays = HORIZON_BY_ARCHETYPE[team.archetype ?? ""] ?? 14;
  const atRisk = open + prioritized;
  const hasMotor = hoyActuar + hoyVigilar + hoyAuto > 0;
  const riskPct = buyers > 0 ? Math.round((atRisk / buyers) * 100) : 0;
  const hasRecovered = revenue > 0;
  // Minor units → moneda real (formatMoney divide ÷100; no formatear a mano).
  // Con filtro de mercado los montos van en la moneda del market (MX→MXN).
  const viewCurrency = scope.market?.currency?.toUpperCase() ?? active.shop_currency;
  const money = (n: number) => formatMoney(Math.round(n), viewCurrency);
  const storeName = displayStoreName(active);
  const reviewHref = withMarketParam("/review", scope.market?.id ?? null);
  // Héroe = carga pendiente hoy (lo que espera tu decisión), no salida del
  // motor: borradores por aprobar + empresas por contactar. El motor queda
  // como contexto (vigilar/valor) y en el embudo.
  const porRevisar = pending + leadsPending;
  const revParts: string[] = [];
  if (pending > 0) revParts.push(`${formatNumber(pending)} cliente${pending === 1 ? "" : "s"} por recuperar`);
  if (leadsPending > 0) revParts.push(`${formatNumber(leadsPending)} empresa${leadsPending === 1 ? "" : "s"} por contactar`);

  const lastRun = (kinds: string[]): RunRow | null =>
    runs.find((r) => kinds.includes(r.kind)) ?? null;
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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
      {/* Héroe reactivo: revalida el server render cada 60s y al volver a
          la pestaña (pipeline/cron cambian los datos con el tab abierto). */}
      <AutoRefresh ms={60_000} />
      <PageHeader
        eyebrow="Tu operación de hoy"
        pulse={porRevisar > 0 || (hasMotor && hoyActuar > 0)}
        title={
          porRevisar > 0
            ? `Hola, ${storeName} — ${formatNumber(porRevisar)} en tu inbox hoy`
            : hasMotor
              ? hoyActuar > 0
                ? `Hola, ${storeName} — ${formatNumber(hoyActuar)} para actuar hoy`
                : `Todo al día, ${storeName}`
              : atRisk > 0
              ? `Hola, ${storeName} — hoy tienes ${formatNumber(atRisk)} ${atRisk === 1 ? "cliente" : "clientes"} por recuperar`
              : `Todo al día, ${storeName}`
        }
        description={
          porRevisar > 0
            ? `${revParts.join(" · ")}.`
            : hasMotor && hoyActuar > 0
              ? undefined
              : hasMotor
                ? pending > 0
                  ? `Nada nuevo hoy; ${formatNumber(pending)} clientes por contactar en Review.`
                  : "Ningún mensaje necesario hoy; la vigilancia sigue."
                : atRisk > 0
                  ? `${formatPercentPoints(riskPct)} de tus ${formatNumber(buyers)} compradores debería haber vuelto ya`
                  : "Ningún cliente vencido. Tu equipo IA sigue vigilando."
        }
        right={
          stores.length > 1 ? (
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
          ) : undefined
        }
      />

      {(tiendaMissing || negocioMissing) && (
        <section aria-label="Configuración pendiente">
          <AppCard
            tone="amber"
            title={
              <span className="inline-flex items-center gap-2">
                <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
                Falta configuración indispensable
              </span>
            }
            description="Sin esto el motor no puede trabajar bien: conecta tu tienda y describe tu negocio."
            footer={
              <span className="flex flex-wrap items-center gap-2">
                {tiendaMissing && (
                  <Button render={<Link href="/settings?tab=tienda" />} nativeButton={false} size="sm">
                    Conectar tienda
                  </Button>
                )}
                {negocioMissing && (
                  <Button
                    render={<Link href="/settings?tab=negocio" />}
                    nativeButton={false}
                    size="sm"
                    variant={tiendaMissing ? "outline" : "default"}
                  >
                    Describir negocio
                  </Button>
                )}
              </span>
            }
          >
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {tiendaMissing && (
                <li>
                  <strong>Tienda sin conectar:</strong> sin Medusa no hay clientes ni pedidos para recuperar.{" "}
                  <Link href="/settings?tab=tienda" className="underline underline-offset-4">
                    Ir a Tienda
                  </Link>
                </li>
              )}
              {negocioMissing && (
                <li>
                  <strong>Negocio sin describir:</strong> sin perfil el motor usa valores genéricos y acierta menos.{" "}
                  <Link href="/settings?tab=negocio" className="underline underline-offset-4">
                    Ir a Negocio
                  </Link>
                </li>
              )}
            </ul>
          </AppCard>
        </section>
      )}

      {error && (
        <AppCardState>{error}</AppCardState>
      )}

      {(hoyActuar + hoyVigilar + hoyAuto > 0) && (
        <section aria-label="Hoy">
          <AppCard
            variant="hero"
            title={
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                Hoy
                {cycleDays !== null ? ` · compran cada ~${formatNumber(cycleDays)}d` : ""}
              </span>
            }
            description={
              <>
                {fotoVieja && (
                  <span className="block">
                    Predicciones de ayer: se actualizan con la próxima corrida del motor.
                  </span>
                )}
                <span className="block tabular-nums">
                  {hoyActuar > 0 ? (
                    <>
                      <AppTooltip tip={DECISION_COPY.puedenNecesitar.tip} contentClassName="max-w-sm">
                        <span>{formatNumber(hoyCercano)} {hoyCercano === 1 ? "puede necesitar mensaje pronto" : "pueden necesitar mensaje pronto"}</span>
                      </AppTooltip>
                      {" · "}
                      <AppTooltip tip={DECISION_COPY.vigiladosSinAccion.tip} contentClassName="max-w-sm">
                        <span>{formatNumber(hoyResidual)} vigilados sin acción hoy</span>
                      </AppTooltip>
                      {" · "}
                      <AppTooltip tip={DECISION_COPY.sinNadaQueHacer.tip} contentClassName="max-w-sm">
                        <span>{formatNumber(hoyAuto)} sin nada que hacer</span>
                      </AppTooltip>
                      {" · "}
                      <AppTooltip tip={DECISION_COPY.valorEsperado.tip} contentClassName="max-w-sm">
                        <span>valor esperado entre {money(hoyLow)} y {money(hoyHigh)}</span>
                      </AppTooltip>
                      {hoyDebiles > 0 ? ` · ${formatNumber(hoyDebiles)} con pocos datos` : ""}
                      {hoyDebilesCercano > 0 ? ` · ${formatNumber(hoyDebilesCercano)} próximos con pocos datos` : ""}
                      {hoyForeign.map((fl) => (
                        <span key={fl.code}>
                          {" "}+{formatNumber(fl.n)} en {fl.code} ({formatMoney(Math.round(fl.value), fl.code)})
                        </span>
                      ))}
                    </>
                  ) : (
                    <>
                      <AppTooltip tip={DECISION_COPY.puedenNecesitar.tip} contentClassName="max-w-sm">
                        <span>{formatNumber(hoyCercano)} {hoyCercano === 1 ? "puede necesitar mensaje pronto" : "pueden necesitar mensaje pronto"}</span>
                      </AppTooltip>
                      {" · "}
                      <AppTooltip tip={DECISION_COPY.vigiladosSinAccion.tip} contentClassName="max-w-sm">
                        <span>{formatNumber(hoyResidual)} vigilados sin acción hoy</span>
                      </AppTooltip>
                      {hoyDebilesCercano > 0 ? ` · ${formatNumber(hoyDebilesCercano)} próximos con pocos datos` : ""}
                      {nextWindowDate ? ` · el próximo puede necesitar mensaje el ${nextWindowDate}` : ""}
                    </>
                  )}
                </span>
              </>
            }
            footer={
              <span className="flex flex-wrap items-center gap-2">
                {(hoyActuar > 0 || pending > 0 || leadsPending > 0 || open + prioritized > 0) && (
                  <Button render={<Link href={reviewHref} />} nativeButton={false} size="sm">
                    Ir al inbox · {formatNumber(pending + leadsPending + open + prioritized)} por gestionar
                  </Button>
                )}
              </span>
            }
          >
            {porRevisar > 0 ? (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-4xl font-semibold tracking-tight tabular-nums">{formatNumber(porRevisar)}</span>
                <span className="text-base">en tu inbox hoy</span>
                <span className="text-xs text-muted-foreground tabular-nums">{revParts.join(" · ")}</span>
              </div>
            ) : hoyActuar > 0 ? (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-4xl font-semibold tracking-tight tabular-nums">{formatNumber(hoyActuar)}</span>
                <AppTooltip tip={DECISION_COPY.paraActuarHoy.tip} contentClassName="max-w-sm">
                  <span className="text-base">para actuar hoy</span>
                </AppTooltip>
                <AppTooltip tip={DECISION_COPY.valorEsperado.tip} contentClassName="max-w-sm">
                  <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary tabular-nums">
                    {money(hoyValor)} valor de actuar hoy
                  </span>
                </AppTooltip>
              </div>
            ) : pending > 0 ? (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-4xl font-semibold tracking-tight tabular-nums">{formatNumber(pending)}</span>
                <span className="text-base">
                  borrador{pending === 1 ? "" : "es"} por tu visto bueno
                </span>
              </div>
            ) : (
              <p className="text-[15px]">Al día — nadie necesita un mensaje.</p>
            )}
          </AppCard>
        </section>
      )}

      <section aria-label="Embudo de recuperación">
        <SectionHeading
          title="Embudo de recuperación"
          hint="De todos los vigilados a los que vuelven: la selectividad es la historia."
          tone="violet"
        />
        <AppCard contentClassName="flex flex-col gap-3">
            {(() => {
              // Funnel completo: empieza en el barrido del motor (el filtro
              // más importante es a quién NO tocar) y termina en recupero.
              // Cada nombre lleva tooltip humano con ejemplo (AppTooltip,
              // SSOT shadcn: sin cursor ni subrayado). Anchos relativos a
              // vigilados: la historia honesta es la selectividad (de 375
              // solo 1 llega).
              const vigilados = hoyActuar + hoyVigilar + hoyAuto;
              const base = vigilados > 0 ? vigilados : atRisk;
              const ejemploActuar =
                topLead && topLead.valorEsperadoMinor != null
                  ? ` Ej.: ${topLead.name} (${money(topLead.valorEsperadoMinor)} en juego).`
                  : "";
              const etapas = [
                {
                  key: "vigilados",
                  label: "Vigilados hoy",
                  n: vigilados,
                  minor: null as number | null,
                  bar: "bg-muted-foreground/30",
                  tip: `El motor revisó hoy a cada cliente con compras y decidió: para actuar hoy, pueden necesitar mensaje pronto, vigilados sin acción hoy o sin nada que hacer. Ej.: hoy ${formatNumber(vigilados)} (${formatNumber(hoyActuar)} para actuar hoy, ${formatNumber(hoyCercano)} pueden necesitar pronto, ${formatNumber(hoyResidual)} vigilados sin acción hoy, ${formatNumber(hoyAuto)} sin nada que hacer).`,
                },
                {
                  key: "actuar",
                  label: "Para actuar hoy",
                  n: hoyActuar,
                  minor: hoyActuar > 0 ? hoyValor : null,
                  bar: "bg-primary",
                  tip: `Lo que dice el modelo hoy, sin memoria: a quién conviene escribir (probabilidad + ventana + valor). Mañana puede decir otra cosa.${ejemploActuar}`,
                },
                {
                  key: "mira",
                  label: "Casos abiertos por gestionar",
                  n: atRisk,
                  minor: atRisk > 0 ? miraValue : null,
                  bar: "bg-violet-500",
                  tip: "El trabajo pendiente: casos abiertos esperando gestión. Es una cola con memoria, no se borra sola aunque el motor cambie de opinión mañana.",
                },
                {
                  key: "borrador",
                  label: "Con borrador",
                  n: pending,
                  minor: pending > 0 ? valorBorrador : null,
                  bar: "bg-amber-500",
                  tip: "Casos con mensaje ya redactado, esperando tu visto bueno en Review. Nada se envía sin tu aprobación.",
                },
                {
                  key: "aprobados",
                  label: "Aprobados",
                  n: approved,
                  minor: approved > 0 ? valorAprobados : null,
                  bar: "bg-sky-500",
                  tip: "Borradores que aprobaste y están listos para que el mensajero los envíe.",
                },
                {
                  key: "recuperados",
                  label: "Recuperados",
                  n: converted,
                  minor: converted > 0 ? revenue : null,
                  bar: "bg-emerald-500",
                  tip: "Clientes que volvieron a comprar tras tu mensaje dentro de la ventana. Es atribuido, no incremental: sin grupo de control no se puede afirmar que fue gracias al mensaje.",
                },
              ];
              return (
                <ol className="flex flex-col gap-2">
                  {etapas.map((e, i) => {
                    const pct = base > 0 ? Math.round((e.n / base) * 100) : 0;
                    const prev = i === 0 ? null : etapas[i - 1];
                    const conv = prev === null || prev.n === 0 ? null : Math.round((e.n / prev.n) * 100);
                    return (
                      <li key={e.key}>
                        <div className="flex items-baseline justify-between gap-2 text-[13px]">
                          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span aria-hidden className={cn("size-1.5 rounded-full", e.bar)} />
                            <AppTooltip tip={e.tip} contentClassName="max-w-sm">
                              <span>{e.label}</span>
                            </AppTooltip>
                            <strong className="tabular-nums">{formatNumber(e.n)}</strong>
                            {e.minor !== null && (
                              <span className="text-muted-foreground tabular-nums">· {money(e.minor)}</span>
                            )}
                          </span>
                          {conv !== null && (
                            <span className="text-xs text-muted-foreground tabular-nums">{formatPercentPoints(conv)} avanza</span>
                          )}
                        </div>
                        <div
                          className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
                          role="img"
                          aria-label={`${e.label}: ${formatNumber(e.n)} (${formatPercentPoints(pct)} de los vigilados)`}
                        >
                          {e.n > 0 && (
                            <div
                              className={cn("h-full rounded-full", e.bar)}
                              style={{ width: `${Math.max(4, pct)}%` }}
                            />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              );
            })()}
            {foreignLines.map((fl) => (
              <span key={fl.code} className="text-xs text-muted-foreground tabular-nums">
                +{formatNumber(fl.n)} en {fl.code} ({formatMoney(Math.round(fl.value), fl.code)}) fuera de esta moneda
              </span>
            ))}
            <p className="text-[13px]">
              Lo próximo:{" "}
              {pending > 0 ? (
                <Link href={reviewHref} className="underline">
                  revisa {formatNumber(pending)} {pending === 1 ? "borrador" : "borradores"}
                </Link>
              ) : approved > 0 ? (
                `${formatNumber(approved)} ${approved === 1 ? "aprobado listo" : "aprobados listos"} para enviar`
              ) : atRisk > 0 ? (
                "contacta a tu mira de hoy"
              ) : (
                "nada — todo al día"
              )}
              {topLead && (
                <>
                  {" "}· Empieza por {topLead.name} (
                  {topLead.valorEsperadoMinor != null
                    ? `${money(topLead.valorEsperadoMinor)} en juego`
                    : `${money(avgTicket(topLead.totalSpent, topLead.ordersCount))} ticket medio`}).
                </>
              )}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatNumber(recentOrders)} {purchaseVerb === "pauta" ? "pautas" : "compras"} últimos 7
              días.
            </p>
          </AppCard>
        </section>



      <section aria-label="Por revisar" className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <AppCard title="Por revisar" contentClassName="flex flex-col gap-3">
          <ul className="flex flex-col gap-1.5 text-[13px] tabular-nums">
              <li>
                <Link href={reviewHref} className="flex items-center gap-2.5 py-1">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <PenLine className="size-4" aria-hidden />
                  </span>
                  <span className="underline underline-offset-4">
                    <strong>{formatNumber(pending)}</strong> cliente{pending === 1 ? "" : "s"} por contactar
                  </span>
                </Link>
              </li>
              <li>
                <Link
                  href={withMarketParam("/review?tab=signals", scope.market?.id ?? null)}
                  className="flex items-center gap-2.5 py-1"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    <Radar className="size-4" aria-hidden />
                  </span>
                  <span className="underline underline-offset-4">
                    <strong>{formatNumber(open)}</strong> por recuperar
                  </span>
                </Link>
              </li>
              <li>
                <Link
                  href={withMarketParam("/review?tab=leads", scope.market?.id ?? null)}
                  className="flex items-center gap-2.5 py-1"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400">
                    <UserPlus className="size-4" aria-hidden />
                  </span>
                  <span className="underline underline-offset-4">
                    <strong>{formatNumber(leadsPending)}</strong> empresa{leadsPending === 1 ? "" : "s"} por contactar
                  </span>
                </Link>
              </li>
              {hoyDebiles > 0 && (
                <li>
                  <Link
                    href={withMarketParam("/customers?decision=actuar", scope.market?.id ?? null)}
                    className="flex items-center gap-2.5 py-1"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-400">
                      <TriangleAlert className="size-4" aria-hidden />
                    </span>
                    <span className="underline underline-offset-4">
                      <strong>{formatNumber(hoyDebiles)}</strong> con pocos datos
                    </span>
                  </Link>
                </li>
              )}
            </ul>
          </AppCard>
        <AppCard
          title="Recuperado · atribuido"
          contentClassName="flex flex-col gap-1"
          className={cn(
            hasRecovered && "bg-gradient-to-br from-emerald-500/[0.07] via-card to-card",
          )}
        >
          <span
              className={cn(
                "text-3xl font-semibold tracking-tight tabular-nums",
                hasRecovered
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-foreground",
              )}
            >
              {money(revenue)}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatNumber(converted)} clientes volvieron tras el mensaje
            </span>
            <span className="text-xs text-muted-foreground">Atribuido, no incremental.</span>
          </AppCard>
        </section>

      <section aria-label="Últimos enviados">
        <SectionHeading
          title="Últimos enviados — ¿volvieron?"
          hint="Qué pasó después del mensaje."
          tone="sky"
        />
        <AppCard contentClassName="flex flex-col divide-y divide-border/60">
            {sentFeed.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                Todavía no se envió ningún mensaje. Cuando apruebes y se despache el primero, acá ves si volvió.
              </p>
            ) : (
              sentFeed.map((s) => {
                const out = dispatchedOutcome({
                  dispatchedAt: s.dispatchedAt,
                  revenueAttributed: s.revenue,
                  windowDays: analystWindowDays,
                  nowMs: Date.now(),
                });
                const agoLabel = s.dispatchedAt ? ago(s.dispatchedAt) : null;
                const outcomeClass =
                  out?.kind === "volvio"
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : out?.kind === "en_ventana"
                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      : "bg-muted text-muted-foreground";
                return (
                  <div
                    key={s.id}
                    className="flex flex-wrap items-start justify-between gap-3 py-3 text-[13px] first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        {s.channel === "whatsapp" ? (
                          <MessageCircle className="size-3.5 text-emerald-500" aria-hidden />
                        ) : (
                          <Mail className="size-3.5 text-sky-500" aria-hidden />
                        )}
                        {s.channel === "whatsapp" ? "WhatsApp" : "Email"}
                      </span>
                      {" · "}
                      <Link
                        href={withMarketParam(`/customers?q=${encodeURIComponent(s.email || s.name)}`, scope.market?.id ?? null)}
                        className="underline underline-offset-4"
                      >
                        {s.name}
                      </Link>{" "}
                      <span className="text-muted-foreground">
                        · {s.body.length > 90 ? `${s.body.slice(0, 90)}…` : s.body}
                      </span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        aprobado por {approverLabel(s.approvedBy)}{agoLabel ? ` · ${agoLabel}` : ""}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
                        outcomeClass,
                      )}
                    >
                      {out?.kind === "volvio"
                        ? `volvió · ${money(out.revenue)}${scope.market ? ` ${viewCurrency}` : ""}`
                        : out?.kind === "en_ventana"
                          ? `en ventana (quedan ${formatNumber(out.daysLeft)}d)`
                          : "no volvió"}
                    </span>
                  </div>
                );
              })
            )}
          </AppCard>
        </section>

      <HealthSection
        storeId={active.id}
        marketId={scope.market?.id ?? null}
        initial={{
          duplicateCount,
          enrichPending,
          sinCanal: hoyGroups.sin_canal,
          buyers,
        }}
      />

      <section aria-label="Tu equipo IA">
        <TeamPulse
            teamVertical={team.vertical}
            teamCycle={team.cycle ?? cycleDays}
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
      </section>

      <details className="group text-[13px]">
        <summary className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
          Cómo va el motor (detalle técnico)
        </summary>
        <AppCard contentClassName="flex flex-col gap-2" className="mt-3">
            <p className="tabular-nums">
              <strong>{formatNumber(open)}</strong> <span className="text-muted-foreground">detectadas</span>
              {" → "}<strong>{formatNumber(prioritized)}</strong> <span className="text-muted-foreground">priorizadas</span>
              {" → "}<strong>{formatNumber(pending)}</strong> <span className="text-muted-foreground">borradores</span>
              {" → "}<strong>{formatNumber(approved)}</strong> <span className="text-muted-foreground">aprobadas</span>
              {" → "}<strong>{formatNumber(dispatched)}</strong> <span className="text-muted-foreground">enviadas</span>
              {" → "}<strong>{formatNumber(converted)}</strong> <span className="text-muted-foreground">recuperadas</span>
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
          </AppCard>
      </details>
    </div>
  );
}
