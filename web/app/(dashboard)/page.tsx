import Link from "next/link";
import { PenLine, Radar, TriangleAlert, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { countDuplicateEmails } from "@/lib/duplicates";
import { pendingDomains } from "@/lib/enrich";
import { formatMoney } from "@/lib/medusa";
import { getStoreProfile, resolveTenantCycleDays } from "@/lib/store-profiles";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { applyScopeFilter, displayMarket, resolveMarketScope, withMarketParam, type MarketScope } from "@/lib/markets";
import {
  displayStoreName,
  getActiveStore,
  type TenantStore,
} from "@/lib/tenant";
import { AgentCard } from "./ask-agent";
import { TeamPulse } from "./team-pulse";
import { AttentionTable, AttentionEmptyState, type AttentionItem } from "./attention-table";
import { HoyHeroActions } from "./hoy-hero-actions";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { avgTicket, getRankedMira } from "@/lib/mira";
import { HORIZON_BY_ARCHETYPE } from "@/lib/retention-model";
import { approverLabel, dispatchedOutcome } from "@/lib/action-trace";

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
    return `Hace ${since[1]} días que ${no} · suele volver entre los ${win[1]}–${win[2]}d`;
  }
  const m =
    raw.match(/sin comprar hace (\d+)d \(media (\d+)d/i) ??
    raw.match(/sin comprar hace (\d+)d \(ciclo ~(\d+)d/i);
  if (m) {
    const s = Number(m[1]);
    const cycle = Math.max(1, Number(m[2]));
    if (s > 10 * cycle)
      return `Hace ${m[1]} días que ${no} · sin ritmo detectable de recompra`;
    return `Hace ${m[1]} días que ${no} · suele volver cada ${m[2]}d`;
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
  // Issue #14 B2: el héroe sumaba plata sin descontar estimaciones débiles.
  // Se cuenta aparte y se declara en el subtítulo (no se descuenta en
  // silencio: el dueño decide si actuar igual).
  let hoyDebiles = 0;
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
        // Con filtro de mercado el market es el universo también en conteos:
        // sin esto el héroe cuenta MX bajo un header "viendo PE · PEN"
        // mientras Finanzas suma solo PE (45 vs 44).
        const cur = (r.currency as string | null) ?? null;
        const inView =
          viewCur === null || cur === null || cur.toUpperCase() === viewCur.toUpperCase();
        if (scope.market && !inView) continue;
        if (d === "actuar" || d === "revision_humana") hoyActuar += 1;
        else if (d === "vigilar") hoyVigilar += 1;
        else hoyAuto += 1;
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
                ? `Hola, ${storeName} — ${hoyActuar} ${hoyActuar === 1 ? "cliente" : "clientes"} esperando tu mensaje hoy`
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
                    {money(hoyValor)} valor de actuar hoy
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
                    {hoyDebiles > 0 ? ` · incluye ${hoyDebiles} estimación${hoyDebiles === 1 ? "" : "es"} inicial${hoyDebiles === 1 ? "" : "es"} (pocos datos)` : ""}
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
          <div>
            <h2 className="text-sm font-medium">Casos abiertos por gestionar ({attention.length})</h2>
            <p className="text-xs text-muted-foreground">
              Cola con memoria: no desaparece aunque el motor cambie de opinión mañana.
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {pending > 0 ? (
              <>
                en Review con borrador ·{" "}
                <Link href={reviewHref} className="underline">
                  revisar ahora
                </Link>
              </>
            ) : atRisk > 0 ? (
              <>
                {atRisk} casos abiertos · redacta y pasan a{" "}
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
              <AttentionEmptyState
                initialRunning={bgRunning(["scout", "strategist"])}
                pending={pending}
                masivos={masivos}
                reviewHref={reviewHref}
              />
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

      <section aria-label="Embudo de recuperación">
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Embudo de recuperación
            </span>
            {(() => {
              // Funnel completo: empieza en el barrido del motor (el filtro
              // más importante es a quién NO tocar) y termina en recupero.
              // Cada nombre lleva tooltip humano con ejemplo (title nativo:
              // sin cursor ni subrayado). Anchos relativos a vigilados: la
              // historia honesta es la selectividad (de 375 solo 1 llega).
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
                  tip: `El motor revisó hoy a cada cliente con compras y decidió: actuar, vigilar o dejar en automático. Ej.: hoy ${vigilados} (${hoyActuar} para actuar, ${hoyVigilar} en vigilancia, ${hoyAuto} en automático).`,
                },
                {
                  key: "actuar",
                  label: "Actuar hoy",
                  n: hoyActuar,
                  minor: hoyActuar > 0 ? hoyValor : null,
                  tip: `Lo que dice el modelo hoy, sin memoria: a quién conviene escribir (probabilidad + ventana + valor). Mañana puede decir otra cosa.${ejemploActuar}`,
                },
                {
                  key: "mira",
                  label: "En la mira",
                  n: atRisk,
                  minor: atRisk > 0 ? miraValue : null,
                  tip: "El trabajo pendiente: casos abiertos esperando gestión. Es una cola con memoria, no se borra sola aunque el motor cambie de opinión mañana.",
                },
                {
                  key: "borrador",
                  label: "Con borrador",
                  n: pending,
                  minor: pending > 0 ? valorBorrador : null,
                  tip: "Casos con mensaje ya redactado, esperando tu visto bueno en Review. Nada se envía sin tu aprobación.",
                },
                {
                  key: "aprobados",
                  label: "Aprobados",
                  n: approved,
                  minor: approved > 0 ? valorAprobados : null,
                  tip: "Borradores que aprobaste y están listos para que el mensajero los envíe.",
                },
                {
                  key: "recuperados",
                  label: "Recuperados",
                  n: converted,
                  minor: converted > 0 ? revenue : null,
                  tip: "Clientes que volvieron a comprar tras tu mensaje dentro de la ventana. Es atribuido, no incremental: sin grupo de control no se puede afirmar que fue gracias al mensaje.",
                },
              ];
              return (
                <TooltipProvider delay={300}>
                <ol className="flex flex-col gap-2">
                  {etapas.map((e, i) => {
                    const pct = base > 0 ? Math.round((e.n / base) * 100) : 0;
                    const prev = i === 0 ? null : etapas[i - 1];
                    const conv = prev === null || prev.n === 0 ? null : Math.round((e.n / prev.n) * 100);
                    return (
                      <li key={e.key}>
                        <div className="flex items-baseline justify-between gap-2 text-[13px]">
                          <span>
                            <Tooltip>
                              <TooltipTrigger render={<span>{e.label}</span>} />
                              <TooltipContent side="top" className="max-w-sm">
                                {e.tip}
                              </TooltipContent>
                            </Tooltip>{" "}
                            <strong className="tabular-nums">{e.n}</strong>
                            {e.minor !== null && (
                              <span className="text-muted-foreground tabular-nums"> · {money(e.minor)}</span>
                            )}
                          </span>
                          {conv !== null && (
                            <span className="text-xs text-muted-foreground tabular-nums">{conv}% avanza</span>
                          )}
                        </div>
                        <div
                          className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
                          role="img"
                          aria-label={`${e.label}: ${e.n} (${pct}% de los vigilados)`}
                        >
                          {e.n > 0 && (
                            <div
                              className="h-full rounded-full bg-primary/70"
                              style={{ width: `${Math.max(4, pct)}%` }}
                            />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                </TooltipProvider>
              );
            })()}
            {foreignLines.map((fl) => (
              <span key={fl.code} className="text-xs text-muted-foreground tabular-nums">
                +{fl.n} en {fl.code} ({formatMoney(Math.round(fl.value), fl.code)}) fuera de esta moneda
              </span>
            ))}
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
                  {topLead.valorEsperadoMinor != null
                    ? `${money(topLead.valorEsperadoMinor)} en juego`
                    : `${money(avgTicket(topLead.totalSpent, topLead.ordersCount))} ticket medio`}).
                </>
              )}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {recentOrders} {purchaseVerb === "pauta" ? "pautas" : "compras"} últimos 7
              días.
            </p>
          </CardContent>
        </Card>
      </section>



      <section aria-label="Por revisar" className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Por revisar
            </span>
            <ul className="flex flex-col gap-1 text-[13px] tabular-nums">
              <li>
                <Link href={reviewHref} className="flex items-center gap-2 underline underline-offset-4">
                  <PenLine className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>
                    <strong>{pending}</strong> mensaje{pending === 1 ? "" : "s"} por aprobar
                  </span>
                </Link>
              </li>
              <li>
                <Link
                  href={withMarketParam("/review?tab=signals", scope.market?.id ?? null)}
                  className="flex items-center gap-2 underline underline-offset-4"
                >
                  <Radar className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>
                    <strong>{open}</strong> cliente{open === 1 ? "" : "s"} en riesgo
                  </span>
                </Link>
              </li>
              <li>
                <Link
                  href={withMarketParam("/review?tab=leads", scope.market?.id ?? null)}
                  className="flex items-center gap-2 underline underline-offset-4"
                >
                  <UserPlus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>
                    <strong>{leadsPending}</strong> empresa{leadsPending === 1 ? "" : "s"} por contactar
                  </span>
                </Link>
              </li>
              {hoyDebiles > 0 && (
                <li>
                  <Link
                    href={withMarketParam("/customers?decision=actuar", scope.market?.id ?? null)}
                    className="flex items-center gap-2 underline underline-offset-4"
                  >
                    <TriangleAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span>
                      <strong>{hoyDebiles}</strong> con estimación inicial (pocos datos) entre quienes toca contactar
                    </span>
                  </Link>
                </li>
              )}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Recuperado · atribuido
            </span>
            <span className="text-2xl font-semibold tabular-nums tracking-tight">{money(revenue)}</span>
            <span className="text-xs text-muted-foreground">{converted} clientes volvieron tras el mensaje</span>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Últimos enviados">
        <div className="mb-2">
          <h2 className="text-sm font-medium">Últimos enviados — ¿volvieron?</h2>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
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
                return (
                  <div key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                    <span className="min-w-0">
                      <span className="font-medium">{s.channel === "whatsapp" ? "WhatsApp" : "Email"}</span>
                      {" · "}
                      <Link href={withMarketParam(`/customers?q=${encodeURIComponent(s.email || s.name)}`, scope.market?.id ?? null)} className="underline">
                        {s.name}
                      </Link>{" "}
                      <span className="text-muted-foreground">
                        · {s.body.length > 90 ? `${s.body.slice(0, 90)}…` : s.body}
                      </span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        aprobado por {approverLabel(s.approvedBy)}{agoLabel ? ` · ${agoLabel}` : ""}
                      </span>
                    </span>
                    <span className="text-xs font-medium tabular-nums">
                      {out?.kind === "volvio"
                        ? `volvió · ${money(out.revenue)}`
                        : out?.kind === "en_ventana"
                          ? `en ventana (quedan ${out.daysLeft}d)`
                          : "no volvió"}
                    </span>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </section>

      <section aria-label="Salud de tu cartera">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Salud de tu cartera</h2>
          <span className="text-xs text-muted-foreground">para que el equipo IA trabaje con datos limpios</span>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            {duplicateCount === 0 && enrichPending === 0 && hoyGroups.sin_canal === 0 ? (
              <p className="text-[13px]">Cartera limpia ✓ — sin duplicados, sin dominios pendientes y con canal utilizable.</p>
            ) : (
              <>
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
                {hoyGroups.sin_canal > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[13px]">
                      <strong>{hoyGroups.sin_canal}</strong>{" "}
                      {hoyGroups.sin_canal === 1 ? "cliente" : "clientes"} sin canal utilizable: el motor no puede escribirles.
                    </p>
                    <Button render={<Link href={withMarketParam("/customers?decision=sin_canal", scope.market?.id ?? null)} />} nativeButton={false} size="sm">
                      Ver sin canal
                    </Button>
                  </div>
                )}
              </>
            )}
            {buyers > 0 && (
              <div className="mt-1 flex flex-col gap-1">
                <div className="h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`Cartera lista: ${Math.max(0, Math.min(100, Math.round(((buyers - duplicateCount - enrichPending - hoyGroups.sin_canal) / buyers) * 100)))}%`}>
                  <div
                    className="h-full rounded-full bg-emerald-500/80"
                    style={{ width: `${Math.max(0, Math.min(100, Math.round(((buyers - duplicateCount - enrichPending - hoyGroups.sin_canal) / buyers) * 100)))}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {Math.max(0, Math.min(100, Math.round(((buyers - duplicateCount - enrichPending - hoyGroups.sin_canal) / buyers) * 100)))}% de cartera lista ({buyers} con compras)
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              La base por ritmo de recompra vive en{" "}
              <Link href={withMarketParam("/customers?ritmo=con-ritmo", scope.market?.id ?? null)} className="underline">
                Customers (filtro por ritmo)
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Tu equipo IA">
        <AgentCard storeId={active.id} storeName={storeName}>
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
            runningLabels={runs.filter((r) => r.status === "running").map((r) => r.label)}
          />
        </AgentCard>
      </section>

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
