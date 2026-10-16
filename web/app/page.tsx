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
import { resolveStoreId } from "@/lib/customers-db";
import { readConnections } from "@/lib/store";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { AgentCard, ClickStop } from "./ask-agent";
import { AttentionTable, type AttentionItem } from "./attention-table";

export const instant = false;

interface StoreRow {
  id: string;
  name: string | null;
  shop_url: string;
  platform: string;
  shop_currency: string;
}

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
  table: "churn_signals" | "proposed_actions" | "customers" | "proposed_leads",
  storeId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: (q: any) => any,
): Promise<number> {
  const db = getSupabase();
  const q = apply(db.from(table).select("id", { count: "exact", head: true }).eq("store_id", storeId));
  const { count, error } = await q;
  if (error) throw new Error(`${table} count: ${error.message}`);
  return count ?? 0;
}

/** "sin comprar hace 64d (media 30d, ...)" → "Hace 64 días que no compra · suele volver cada 30d". */
function humanReason(raw: string | null, fallbackKind: string): string {
  if (!raw) return fallbackKind;
  const m = raw.match(/sin comprar hace (\d+)d \(media (\d+)d/i);
  if (m) return `Hace ${m[1]} días que no compra · suele volver cada ${m[2]}d`;
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
  searchParams: Promise<{ store?: string }>;
}) {
  const dbReady = isSupabaseConfigured();
  const conn = await readConnections();
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
  const { data: storesData, error: storesErr } = await db
    .from("stores")
    .select("id,name,shop_url,platform,shop_currency")
    .order("created_at", { ascending: true })
    .limit(50);
  if (storesErr) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">
            Stores read: {storesErr.message}
          </CardContent>
        </Card>
      </div>
    );
  }
  const stores = ((storesData ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: (r.name as string | null) ?? null,
    shop_url: String(r.shop_url ?? ""),
    platform: String(r.platform ?? ""),
    shop_currency: String(r.shop_currency ?? "PEN"),
  })) satisfies StoreRow[];

  if (stores.length === 0) {
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

  // Tenant activo: ?store=uuid > conexión local > primera tienda.
  let activeId = sp.store ?? null;
  if (!activeId || !stores.some((s) => s.id === activeId)) {
    const viaConn = conn.medusaUrl ? await resolveStoreId(conn.medusaUrl).catch(() => null) : null;
    activeId = (viaConn && stores.some((s) => s.id === viaConn) ? viaConn : null) ?? stores[0].id;
  }
  const active = stores.find((s) => s.id === activeId) ?? stores[0];

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
  let team: TeamProfile = { vertical: null, buyerType: null, cycle: null, archetype: null, confidence: null, learnedAt: null };

  try {
    const [
      openN,
      priN,
      pendN,
      apprN,
      dispN,
      buyersN,
      leadsN,
      revRows,
      topRows,
      runRows,
      profileRow,
    ] = await Promise.all([
      countExact("churn_signals", active.id, (q) => q.in("status", ["open"])),
      countExact("churn_signals", active.id, (q) => q.eq("status", "prioritized")),
      countExact("proposed_actions", active.id, (q) => q.eq("status", "pending_review")),
      countExact("proposed_actions", active.id, (q) => q.eq("status", "approved")),
      countExact("proposed_actions", active.id, (q) => q.eq("status", "dispatched")),
      countExact("customers", active.id, (q) => q.gt("orders_count", 0)),
      countExact("proposed_leads", active.id, (q) => q.eq("status", "pending_review")),
      db
        .from("proposed_actions")
        .select("revenue_attributed")
        .eq("store_id", active.id)
        .not("revenue_attributed", "is", null)
        .limit(500),
      db
        .from("churn_signals")
        .select("id,customer_id,kind,score,reason,status,customers(email,first_name,last_name,orders_count,total_spent)")
        .eq("store_id", active.id)
        .in("status", ["open", "prioritized"])
        .order("score", { ascending: false, nullsFirst: false })
        .limit(7),
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
    ]);
    open = openN;
    prioritized = priN;
    pending = pendN;
    approved = apprN;
    dispatched = dispN;
    buyers = buyersN;
    leadsPending = leadsN;

    const revs = ((revRows.data ?? []) as Array<Record<string, unknown>>).map((r) =>
      Number(r.revenue_attributed ?? 0),
    );
    revenue = revs.reduce((a, b) => a + b, 0);
    converted = revs.filter((v) => v > 0).length;

    attention = (((topRows.data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const c = (r.customers ?? {}) as Record<string, unknown>;
      const name =
        [c.first_name, c.last_name].filter(Boolean).join(" ") || String(c.email ?? "");
      const kind = String(r.kind ?? "churn_risk");
      return {
        signalId: String(r.id),
        customerDbId: String(r.customer_id ?? ""),
        kind,
        score: r.score == null ? null : Number(r.score),
        reason: humanReason((r.reason as string | null) ?? null, kind),
        email: String(c.email ?? ""),
        name,
        ordersCount: Number(c.orders_count ?? 0),
        totalSpent: Number(c.total_spent ?? 0),
      } satisfies AttentionRow;
    }));
    // Valor × probabilidad: score primero, gasto como desempate.
    attention.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.totalSpent - a.totalSpent);

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
  const money = (n: number) =>
    `${active.shop_currency} ${Math.round(n).toLocaleString("es-PE")}`;
  const storeName = active.name ?? active.shop_url;

  const lastRun = (kinds: string[]): RunRow | null =>
    runs.find((r) => kinds.includes(r.kind)) ?? null;
  const scoutRun = lastRun(["scout"]);
  const strategistRun = lastRun(["strategist"]);
  const copywriterRun = lastRun(["copywriter"]);
  const prospectRun = lastRun(["prospect"]);
  const dispatcherRun = lastRun(["dispatcher"]);
  const analystRun = lastRun(["analyst"]);

  const runLine = (r: RunRow | null, idle: string) =>
    r
      ? `trabajó ${ago(r.started_at) ?? "recientemente"}${r.summary ? ` · ${r.summary}` : ""}`
      : idle;

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
              ? `Hola, ${storeName} — hoy tienes ${atRisk} por recuperar`
              : `Todo al día, ${storeName}`}
          </h1>
          <span className="text-xs text-muted-foreground">
            {atRisk > 0
              ? `${riskPct}% de tus ${buyers} compradores debería haber vuelto ya`
              : "Ningún cliente vencido. Tu equipo IA sigue vigilando."}
          </span>
        </div>
        {stores.length > 1 && (
          <span className="flex flex-wrap items-center gap-2">
            {stores.map((s) => (
              <Button
                key={s.id}
                render={<Link href={s.id === active.id ? "/" : `/?store=${s.id}`} />}
                nativeButton={false}
                variant={s.id === active.id ? "default" : "outline"}
                size="sm"
              >
                {s.name ?? s.shop_url}
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
                <>para revisar y enviar por WhatsApp · <Link href="/review" className="underline">revisar ahora</Link></>
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

      <section>
        <h2 className="mb-1 text-sm font-medium">Tu equipo IA</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Cada agente hace una parte por ti. Tú solo revisas y apruebas — ellos vigilan, proponen y miden.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <AgentCard storeId={active.id} storeName={storeName} foco="perfilador">
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
          <AgentCard storeId={active.id} storeName={storeName} foco="vigilancia">
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
          <AgentCard storeId={active.id} storeName={storeName} foco="propuesta">
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
                  <Button render={<Link href="/review" />} nativeButton={false} variant="outline" size="sm">
                    Revisar ahora
                  </Button>
                </ClickStop>
              )}
            </CardContent>
          </AgentCard>
          <AgentCard storeId={active.id} storeName={storeName} foco="cierre">
            <CardContent className="flex flex-col gap-2 p-4">
              <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <TrendingUp className="size-3.5 text-primary" aria-hidden /> Cierran el loop
              </span>
              <span className="flex items-start gap-2 text-[13px]">
                <Send className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <strong>Mensajero</strong> envía solo lo que aprobaste, nada sin tu permiso.
                  <span className="block text-xs text-muted-foreground">
                    {dispatched > 0 ? `${dispatched} enviadas` : "aún sin envíos"}
                    {approved > 0 ? ` · ${approved} aprobadas en cola` : ""}
                    {dispatcherRun?.summary ? ` · ${dispatcherRun.summary}` : ""}
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
          <h2 className="text-sm font-medium">Hoy</h2>
          <span className="text-xs text-muted-foreground">
            {atRisk > 0 ? `${atRisk} en la mira · clic para ver su historial` : "sin pendientes"}
          </span>
        </div>
        <Card>
          <CardContent className="p-0">
            {attention.length === 0 ? (
              <p className="p-4 text-[13px] text-muted-foreground">
                Todo al día — ningún cliente vencido. Tu equipo IA sigue vigilando.
              </p>
            ) : (
              <AttentionTable rows={attention} currency={active.shop_currency} />
            )}
          </CardContent>
        </Card>
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
