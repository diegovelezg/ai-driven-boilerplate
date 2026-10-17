import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { readConnections } from "@/lib/store";
import { isSupabaseConfigured, getSupabase } from "@/lib/supabase";
import { resolveStoreId } from "@/lib/customers-db";
import { RetentionControls } from "./retention-controls";
import {
  ReviewLists,
  type ActionRow,
  type LeadRow,
  type SignalRow,
} from "./review-lists";
import { getRankedMira } from "@/lib/mira";
import {
  applyScopeFilter,
  displayMarket,
  resolveMarketScope,
} from "@/lib/markets";

export const instant = false;

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    market?: string;
    /** Filtro del chat ("muéstrame los 3"): IDs exactos por sección. */
    actionIds?: string;
    leadIds?: string;
    signalIds?: string;
  }>;
}) {
  const conn = await readConnections();
  const connected = Boolean(conn.medusaUrl);
  const dbReady = isSupabaseConfigured();
  const sp = await searchParams;

  let actions: ActionRow[] = [];
  let leads: LeadRow[] = [];
  let signals: SignalRow[] = [];
  let runningKinds = new Set<string>();
  let error: string | null = null;
  /** Dominios que ya son customers (para el check “no es cliente actual”). */
  const customerDomains = new Set<string>();
  let shopCurrency: string | null = null;
  let marketLabel: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = await resolveStoreId(conn.medusaUrl);
      if (!storeId) {
        error = "Tienda aún sin sincronizar.";
      } else {
        const db = getSupabase();
        // Filtro global por país/mercado (?market= del header). Acciones y
        // señales filtran por sus customers; leads no tienen país (van todos).
        const scope = await resolveMarketScope(storeId, sp.market).catch(() => null);
        marketLabel = scope?.market ? displayMarket(scope.market) : null;
        const [{ data: a, error: aErr }, { data: l, error: lErr }, { data: br }] =
          await Promise.all([
            (async () => {
              const aq = applyScopeFilter(
                db
                  .from("proposed_actions")
                  .select("id,customer_id,channel,subject,body,status,created_at,customers(email,first_name,last_name),churn_signals(reason,score,kind)")
                  .eq("store_id", storeId)
                  .eq("status", "pending_review"),
                scope,
              );
              return aq.order("created_at", { ascending: false }).limit(30);
            })(),
            applyScopeFilter(
              db
                .from("proposed_leads")
                .select("id,company,domain,url,contact,source,created_at,icp_score,reason,evidence_json")
                .eq("store_id", storeId)
                .eq("status", "pending_review"),
              scope,
              null,
            )
              .order("icp_score", { ascending: false, nullsFirst: false })
              .limit(30),
            // Corridas en curso: la sección vacía muestra skeleton, no un vacío engañoso.
            db
              .from("background_runs")
              .select("kind,status")
              .eq("store_id", storeId)
              .order("started_at", { ascending: false })
              .limit(10),
          ]);
        if (aErr) throw new Error(`Actions read: ${aErr.message}`);
        if (lErr) throw new Error(`Leads read: ${lErr.message}`);
        runningKinds = new Set(
          ((br ?? []) as Array<Record<string, unknown>>)
            .filter((r) => r.status === "running")
            .map((r) => String(r.kind ?? "")),
        );
        actions = ((a ?? []) as Array<Record<string, unknown>>).map((r) => {
          const c = (r.customers ?? {}) as Record<string, unknown>;
          const sig = (r.churn_signals ?? {}) as Record<string, unknown>;
          const name =
            [c.first_name, c.last_name].filter(Boolean).join(" ") || String(c.email ?? "");
          return {
            id: String(r.id),
            channel: String(r.channel ?? "?"),
            subject: (r.subject as string | null) ?? null,
            body: String(r.body ?? ""),
            status: String(r.status ?? ""),
            created_at: String(r.created_at ?? ""),
            email: String(c.email ?? ""),
            name,
            reason: (sig.reason as string | null) ?? null,
            score: sig.score == null ? null : Number(sig.score),
            kind: (sig.kind as string | null) ?? null,
            generator: ((r.evidence_json as Record<string, unknown> | null)?.generator as string | null) ?? null,
          };
        });
        leads = ((l ?? []) as Array<Record<string, unknown>>).map((r) => ({
          id: String(r.id),
          company: (r.company as string | null) ?? null,
          domain: (r.domain as string | null) ?? null,
          url: String(r.url ?? ""),
          contact: (r.contact as string | null) ?? null,
          source: (r.source as string | null) ?? null,
          created_at: String(r.created_at ?? ""),
          icp_score: r.icp_score == null ? null : Number(r.icp_score),
          reason: (r.reason as string | null) ?? null,
          evidence: (r.evidence_json as LeadRow["evidence"]) ?? null,
        }));
        // Solo el check “ya es customer” se calcula en vivo (barato); el resto
        // viene guardado por el agente al crear el lead (evidence_json).
        try {
          const [{ data: ce }, { data: st }] = await Promise.all([
            db.from("customers").select("email").eq("store_id", storeId).limit(5000),
            db.from("stores").select("shop_currency").eq("id", storeId).maybeSingle(),
          ]);
          const { domainFromEmail, classifyDomain } = await import("@/lib/domains");
          for (const c of ((ce ?? []) as Array<Record<string, unknown>>)) {
            const d = domainFromEmail(String(c.email ?? ""));
            if (d && classifyDomain(d).enrichable) customerDomains.add(d);
          }
          shopCurrency = ((st ?? {}) as Record<string, unknown>).shop_currency as string | null ?? null;
          // Con filtro de mercado los montos se leen en su moneda (MX→MXN).
          if (scope?.market?.currency) shopCurrency = scope.market.currency.toUpperCase();
        } catch {
          // checks degradados: se muestra lo que haya
        }
        // Mismo ranking que el Overview (lib/mira): la #1 de Hoy es la #1 aquí.
        // Universos monetarios: la foránea va después, no mezclada.
        // Con filtro de mercado el market es el universo (foreign vacío).
        const mira = await getRankedMira(storeId, 100, {
          ...(scope ?? {}),
          currency: scope?.market?.currency?.toUpperCase() ?? null,
        });
        signals = [...mira.rows, ...mira.foreign].map((r) => ({
          id: r.signalId,
          kind: r.kind,
          score: r.score,
          reason: r.reason,
          status: r.status,
          email: r.email,
          name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
        }));
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  // Filtro del chat: IDs exactos ("muéstrame los 3"). Se aplica sobre lo ya
  // cargado (respeta mercado); con IDs inexistentes la sección queda vacía.
  const parseIds = (raw: string | undefined): Set<string> | null => {
    if (!raw) return null;
    const set = new Set(
      raw.split(",").map((s) => s.trim()).filter(Boolean),
    );
    return set.size > 0 ? set : null;
  };
  const actionFilter = parseIds(sp.actionIds);
  const leadFilter = parseIds(sp.leadIds);
  const signalFilter = parseIds(sp.signalIds);
  if (actionFilter) actions = actions.filter((a) => actionFilter.has(a.id));
  if (leadFilter) leads = leads.filter((l) => leadFilter.has(l.id));
  if (signalFilter) signals = signals.filter((s) => signalFilter.has(s.id));
  const chatFiltered =
    (actionFilter ? ` · ${actions.length} borradores` : "") +
    (leadFilter ? ` · ${leads.length} leads` : "") +
    (signalFilter ? ` · ${signals.length} señales` : "");
  // Con filtro del chat, la vista muestra SOLAMENTE lo pedido: las secciones
  // no filtradas se ocultan en vez de seguir listando todo.
  const showActions = !chatFiltered || Boolean(actionFilter);
  const showLeads = !chatFiltered || Boolean(leadFilter);
  const showSignals = !chatFiltered || Boolean(signalFilter);
  const clearChatFilter = sp.market
    ? `/review?market=${encodeURIComponent(sp.market)}`
    : "/review";

  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight">
          Review{marketLabel ? ` · ${marketLabel}` : ""}
        </h1>
        {connected && dbReady && !error && <RetentionControls />}
      </header>

      {chatFiltered && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
            <p className="text-[13px]">
              Filtrado por el chat{chatFiltered}.
            </p>
            <Button render={<Link href={clearChatFilter} />} nativeButton={false} variant="outline" size="sm">
              Limpiar filtro
            </Button>
          </CardContent>
        </Card>
      )}

      {(!connected || !dbReady) && (
        <Card>
          <CardContent className="p-4">
            <p className="text-[13px] text-muted-foreground">
              {!connected
                ? "Conecta Medusa en Settings para revisar propuestas."
                : "Supabase no configurado (`supabase start` + `web/.env.local`)."}
            </p>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card>
          <CardContent className="p-4">
            <p className="text-[13px] text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      )}

      {connected && dbReady && !error && (
        <>
          <ReviewLists
            actions={actions}
            leads={leads}
            signals={signals}
            visible={{ actions: showActions, leads: showLeads, signals: showSignals }}
            runningKinds={[...runningKinds]}
            marketLabel={marketLabel}
            customerDomains={[...customerDomains]}
            shopCurrency={shopCurrency}
            filtered={Boolean(chatFiltered)}
          />

        </>
      )}
    </div>
  );
}
