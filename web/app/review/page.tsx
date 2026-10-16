import { Card, CardContent } from "@/components/ui/card";
import { readConnections } from "@/lib/store";
import { isSupabaseConfigured, getSupabase } from "@/lib/supabase";
import { resolveStoreId } from "@/lib/customers-db";
import {
  approveActionAction,
  approveLeadAction,
  dismissSignalAction,
  rejectActionAction,
  rejectLeadAction,
} from "@/lib/review-actions";
import { ApprovePair, DismissButton } from "./review-buttons";
import { RetentionControls } from "./retention-controls";

export const instant = false;

interface ActionRow {
  id: string;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  created_at: string;
  email: string;
  name: string;
  reason: string | null;
  score: number | null;
  kind: string | null;
}

interface LeadRow {
  id: string;
  company: string | null;
  domain: string | null;
  url: string;
  icp_score: number | null;
  reason: string | null;
}

interface SignalRow {
  id: string;
  kind: string;
  score: number | null;
  reason: string | null;
  status: string;
  email: string;
  name: string;
}

export default async function ReviewPage() {
  const conn = await readConnections();
  const connected = Boolean(conn.medusaUrl);
  const dbReady = isSupabaseConfigured();

  let actions: ActionRow[] = [];
  let leads: LeadRow[] = [];
  let signals: SignalRow[] = [];
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = await resolveStoreId(conn.medusaUrl);
      if (!storeId) {
        error = "Tienda aún sin sincronizar.";
      } else {
        const db = getSupabase();
        const [{ data: a, error: aErr }, { data: l, error: lErr }, { data: s, error: sErr }] =
          await Promise.all([
            db
              .from("proposed_actions")
              .select("id,channel,subject,body,status,created_at,customers(email,first_name,last_name),churn_signals(reason,score,kind)")
              .eq("store_id", storeId)
              .eq("status", "pending_review")
              .order("created_at", { ascending: false })
              .limit(30),
            db
              .from("proposed_leads")
              .select("id,company,domain,url,icp_score,reason")
              .eq("store_id", storeId)
              .eq("status", "pending_review")
              .order("icp_score", { ascending: false, nullsFirst: false })
              .limit(30),
            db
              .from("churn_signals")
              .select("id,kind,score,reason,status,customers(email,first_name,last_name)")
              .eq("store_id", storeId)
              .in("status", ["open", "prioritized"])
              .order("score", { ascending: false, nullsFirst: false })
              .limit(30),
          ]);
        if (aErr) throw new Error(`Actions read: ${aErr.message}`);
        if (lErr) throw new Error(`Leads read: ${lErr.message}`);
        if (sErr) throw new Error(`Signals read: ${sErr.message}`);
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
          };
        });
        leads = ((l ?? []) as Array<Record<string, unknown>>).map((r) => ({
          id: String(r.id),
          company: (r.company as string | null) ?? null,
          domain: (r.domain as string | null) ?? null,
          url: String(r.url ?? ""),
          icp_score: r.icp_score == null ? null : Number(r.icp_score),
          reason: (r.reason as string | null) ?? null,
        }));
        signals = ((s ?? []) as Array<Record<string, unknown>>).map((r) => {
          const c = (r.customers ?? {}) as Record<string, unknown>;
          const name =
            [c.first_name, c.last_name].filter(Boolean).join(" ") || String(c.email ?? "");
          return {
            id: String(r.id),
            kind: String(r.kind ?? "?"),
            score: r.score == null ? null : Number(r.score),
            reason: (r.reason as string | null) ?? null,
            status: String(r.status ?? ""),
            email: String(c.email ?? ""),
            name,
          };
        });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Review</h1>
        {connected && dbReady && !error && <RetentionControls />}
      </header>

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
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">
              Acciones propuestas ({actions.length})
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                el copywriter propone, el humano aprueba; dispatcher solo envía aprobadas
              </span>
            </h2>
            {actions.length === 0 && (
              <Card>
                <CardContent className="p-4 text-[13px] text-muted-foreground">
                  Sin borradores pendientes. Corre Scout → Estratega → Copywriter.
                </CardContent>
              </Card>
            )}
            {actions.map((a) => (
              <Card key={a.id}>
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-medium">
                      {a.name} <span className="font-normal text-muted-foreground">· {a.email}</span>
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {a.channel}
                      {a.kind ? ` · ${a.kind}` : ""}
                      {a.score != null ? ` · score ${a.score}` : ""}
                    </span>
                  </div>
                  {a.reason && (
                    <p className="text-xs text-muted-foreground">Motivo: {a.reason}</p>
                  )}
                  {a.subject && <p className="text-[13px] font-medium">{a.subject}</p>}
                  <p className="whitespace-pre-wrap text-[13px]">{a.body}</p>
                  <ApprovePair id={a.id} onApprove={approveActionAction} onReject={rejectActionAction} />
                </CardContent>
              </Card>
            ))}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Leads propuestos ({leads.length})</h2>
            {leads.length === 0 && (
              <Card>
                <CardContent className="p-4 text-[13px] text-muted-foreground">
                  Sin leads pendientes.
                </CardContent>
              </Card>
            )}
            {leads.map((l) => (
              <Card key={l.id}>
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-medium">
                      {l.company ?? l.domain ?? l.url}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {l.icp_score != null ? `score ${l.icp_score}` : ""}
                    </span>
                  </div>
                  {l.reason && (
                    <p className="text-xs text-muted-foreground">{l.reason}</p>
                  )}
                  <a href={l.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
                    {l.url}
                  </a>
                  <ApprovePair id={l.id} onApprove={approveLeadAction} onReject={rejectLeadAction} />
                </CardContent>
              </Card>
            ))}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Señales abiertas ({signals.length})</h2>
            {signals.map((s) => (
              <Card key={s.id}>
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-medium">
                      {s.name} <span className="font-normal text-muted-foreground">· {s.email}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {s.status} · {s.kind}
                      {s.score != null ? ` · score ${s.score}` : ""}
                      {s.reason ? ` · ${s.reason}` : ""}
                    </span>
                  </div>
                  <DismissButton id={s.id} onDismiss={dismissSignalAction} />
                </CardContent>
              </Card>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
