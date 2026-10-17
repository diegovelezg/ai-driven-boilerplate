"use client";

import { Card, CardContent } from "@/components/ui/card";
import { SectionLoading } from "@/components/section-loading";
import { formatMoney } from "@/lib/medusa";
import { COPYWRITER_GEN } from "@/lib/copywriter-gen";
import {
  approveActionAction,
  approveLeadAction,
  dismissSignalAction,
  regenerateStaleDraftsAction,
  rejectActionAction,
  rejectLeadAction,
} from "@/lib/review-actions";
import { ApprovePair, DismissButton, RegenerateButton } from "./review-buttons";

export interface ActionRow {
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
  generator: string | null;
}

export interface LeadRow {
  id: string;
  company: string | null;
  domain: string | null;
  url: string;
  contact: string | null;
  source: string | null;
  created_at: string;
  icp_score: number | null;
  reason: string | null;
  evidence: {
    queries?: string[];
    similar?: Array<{
      domain: string;
      label?: string;
      industry?: string;
      spent_minor?: number;
      orders?: number;
      why: string;
    }>;
  } | null;
}

export interface SignalRow {
  id: string;
  kind: string;
  score: number | null;
  reason: string | null;
  status: string;
  email: string;
  name: string;
}

/** Listas del inbox: UN renderer para /review y para el canvas del chat.
 *  Recibe filas ya filtradas; `visible` decide qué secciones se muestran
 *  (con filtro del chat, solo lo pedido). Mutaciones por las mismas
 *  server actions en ambos hosts. */
export function ReviewLists({
  actions,
  leads,
  signals,
  visible,
  runningKinds = [],
  marketLabel = null,
  customerDomains = null,
  shopCurrency = null,
  filtered = false,
}: {
  actions: ActionRow[];
  leads: LeadRow[];
  signals: SignalRow[];
  visible: { actions: boolean; leads: boolean; signals: boolean };
  runningKinds?: string[];
  marketLabel?: string | null;
  /** null = sin verificar (canvas): se omite el check de duplicado. */
  customerDomains?: string[] | null;
  shopCurrency?: string | null;
  /** Filtro del chat activo: vacíos con mensaje de filtro, no de inbox. */
  filtered?: boolean;
}) {
  const emptyActions = filtered
    ? "Sin resultados para ese filtro."
    : "Sin borradores pendientes. Corre Scout → Estratega → Copywriter.";
  const emptyLeads = filtered ? "Sin resultados para ese filtro." : "Sin leads pendientes.";

  return (
    <>
      {visible.actions && (
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            Acciones propuestas ({actions.length})
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              el copywriter propone, el humano aprueba; dispatcher solo envía aprobadas
            </span>
          </h2>
          <RegenerateButton
            count={actions.filter((a) => a.generator !== COPYWRITER_GEN).length}
            onRegenerate={regenerateStaleDraftsAction}
          />
        </div>
        {actions.length === 0 &&
          (runningKinds.includes("copywriter") ? (
            <Card>
              <CardContent className="p-4">
                <SectionLoading label="borradores" />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-4 text-[13px] text-muted-foreground">
                {emptyActions}
              </CardContent>
            </Card>
          ))}
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
              <details className="rounded-md bg-muted/50 px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium hover:text-foreground">
                  Por qué se propone (sustento)
                </summary>
                <div className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
                  <span>
                    <strong className="text-foreground">Regla:</strong>{" "}
                    {a.kind === "vip_care"
                      ? "3+ compras y gasto en el top 20% → cuidado VIP, vale 1-a-1"
                      : a.kind === "winback"
                        ? "1 sola compra y vencido → winback, la 2ª compra define si se queda"
                        : a.kind === "nurture"
                          ? "2+ compras, gasto medio → nurture, reactivar hábito"
                          : "señal de churn vencida → recupero"}{" "}
                    {a.score != null ? `· score ${a.score}` : ""} {a.reason ? `· ${a.reason}` : ""}
                  </span>
                  <span>
                    Canal {a.channel}: {a.channel === "whatsapp" ? "hay teléfono, se prefiere WhatsApp (≤400 chars)" : "sin teléfono a la vista, se usa email"} ·
                    el texto usa solo historial real, sin cifras inventadas.
                  </span>
                  <span>
                    {a.generator === COPYWRITER_GEN
                      ? "✓ criterios actuales"
                      : "⚠ criterios anteriores — usa “Regenerar” arriba para rehacerlo"}
                  </span>
                </div>
              </details>
              <ApprovePair id={a.id} onApprove={approveActionAction} onReject={rejectActionAction} />
            </CardContent>
          </Card>
        ))}
      </section>
      )}

      {visible.leads && (
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">
          Leads propuestos ({leads.length})
          {marketLabel && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              sin país atribuido: van todos
            </span>
          )}
        </h2>
        {leads.length === 0 &&
          (runningKinds.includes("prospect") ? (
            <Card>
              <CardContent className="p-4">
                <SectionLoading label="leads" rows={2} />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-4 text-[13px] text-muted-foreground">
                {emptyLeads}
              </CardContent>
            </Card>
          ))}
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
              <details className="rounded-md bg-muted/50 px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium hover:text-foreground">
                  Por qué se propone (sustento del agente)
                </summary>
                <div className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
                  {!l.evidence || (l.evidence.similar ?? []).length === 0 ? (
                    <span>
                      Sin referentes guardados (lead de corrida anterior al sustento). Juicio del modelo: {l.reason ?? "—"}
                    </span>
                  ) : (
                    <>
                      <span>
                        <strong className="text-foreground">Se parece a:</strong>
                      </span>
                      {(l.evidence.similar ?? []).map((s) => (
                        <span key={s.domain}>
                          · <strong className="text-foreground">{s.label ?? s.domain}</strong> ({s.domain})
                          {s.industry ? ` · ${s.industry}` : ""}
                          {s.spent_minor != null ? ` · ${formatMoney(s.spent_minor, shopCurrency)}` : ""}
                          {s.orders != null ? ` en ${s.orders} ${s.orders === 1 ? "compra" : "compras"}` : ""} ·{" "}
                          {s.why}
                        </span>
                      ))}
                    </>
                  )}
                  <span>
                    {customerDomains != null && (
                      <>
                        {l.domain && customerDomains.includes(l.domain.toLowerCase())
                          ? "⚠ este dominio YA es customer (posible duplicado)"
                          : "✓ no es customer actual"}{" "}
                        ·{" "}
                      </>
                    )}
                    {l.contact ? `✓ contacto público: ${l.contact}` : "✗ sin contacto público (solo formulario)"} ·{" "}
                    score {l.icp_score ?? "?"} · {l.source ?? "searxng"}
                    {l.created_at ? ` · hallado ${l.created_at.slice(0, 10)}` : ""}
                  </span>
                </div>
              </details>
              <ApprovePair id={l.id} onApprove={approveLeadAction} onReject={rejectLeadAction} />
            </CardContent>
          </Card>
        ))}
      </section>
      )}

      {visible.signals && (
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Señales abiertas ({signals.length})</h2>
        {signals.length === 0 &&
          (runningKinds.includes("scout") || runningKinds.includes("strategist")) && (
            <Card>
              <CardContent className="p-4">
                <SectionLoading label="señales" rows={2} />
              </CardContent>
            </Card>
          )}
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
      )}
    </>
  );
}
