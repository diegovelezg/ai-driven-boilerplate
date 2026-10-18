"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "cn";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  revokeApprovalAction,
} from "@/lib/review-actions";
import { ApprovePair, DismissButton, RegenerateButton, RevokeButton } from "./review-buttons";

export interface ActionRow {
  id: string;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  created_at: string;
  customerId?: string;
  email: string;
  name: string;
  reason: string | null;
  score: number | null;
  kind: string | null;
  generator: string | null;
  /** Evidencia del motor (opcionales: borradores viejos usan el respaldo). */
  predCycleDays?: number | null;
  predTDays?: number | null;
  predHorizon?: number | null;
  predP?: number | null;
  predPLow?: number | null;
  predPHigh?: number | null;
  predTicketMinor?: number | null;
  predConfidence?: string | null;
  lastOrderAt?: string | null;
  lastOrderItems?: string[] | null;
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

/** Tab del inbox: una cola por trabajo (retención vs adquisición vs contexto). */
export type ReviewTab = "actions" | "leads" | "signals";

/** Listas del inbox: UN renderer para /review y para el canvas del chat.
 *  Recibe filas ya filtradas; `visible` decide qué secciones se muestran
 *  (con filtro del chat, solo lo pedido). Mutaciones por las mismas
 *  server actions en ambos hosts. */
export function ReviewLists({
  actions,
  approvedActions = [],
  leads,
  signals,
  visible,
  runningKinds = [],
  marketLabel = null,
  customerDomains = null,
  shopCurrency = null,
  filtered = false,
  initialTab = "actions",
  ultimaCompraLabel = "última compra",
  /** true = tenant B2B: sin barra de aprobación en lote. Default seguro. */
  isB2B = true,
}: {
  actions: ActionRow[];
  /** Aprobadas aún no enviadas: visibles para poder revocarlas. */
  approvedActions?: ActionRow[];
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
  initialTab?: ReviewTab;
  ultimaCompraLabel?: string;
  isB2B?: boolean;
}) {
  const router = useRouter();
  const tabs: Array<{ id: ReviewTab; label: string; show: boolean }> = [
    { id: "actions", label: `Acciones (${actions.length})`, show: visible.actions },
    { id: "leads", label: `Leads (${leads.length})`, show: visible.leads },
    { id: "signals", label: `Señales (${signals.length})`, show: visible.signals },
  ];
  const shown = tabs.filter((t) => t.show);
  const fallback = shown[0]?.id ?? "actions";
  const [active, setActive] = useState<ReviewTab>(
    tabs.some((t) => t.id === initialTab && t.show) ? initialTab : fallback,
  );
  const selectTab = (id: ReviewTab) => {
    setActive(id);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", id);
    router.replace(`?${params.toString()}`, { scroll: false });
  };
  // Aprobación en lote (solo no-B2B): reutiliza approveActionAction por id.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchMsg, setBatchMsg] = useState<string | null>(null);
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const approveSelected = async () => {
    if (batchBusy || selected.size === 0) return;
    setBatchBusy(true);
    setBatchMsg(null);
    let ok = 0;
    for (const id of selected) {
      const r = await approveActionAction(id);
      if (r.ok) ok += 1;
    }
    setBatchMsg(`${ok} de ${selected.size} aprobadas.`);
    setSelected(new Set());
    setBatchBusy(false);
    router.refresh();
  };
  const emptyActions = filtered
    ? "Sin resultados para ese filtro."
    : "Sin borradores pendientes. Pídelos en el chat o desde Overview.";
  const emptyLeads = filtered ? "Sin resultados para ese filtro." : "Sin leads pendientes.";

  return (
    <>
      {shown.length > 1 && (
        <div role="tablist" aria-label="Colas de revisión" className="flex w-fit gap-1 rounded-lg bg-muted p-1">
          {shown.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={active === t.id}
              onClick={() => selectTab(t.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                active === t.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {visible.actions && active === "actions" && (
      <section className="flex flex-col gap-3" role="tabpanel">
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
        {!isB2B && actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={batchBusy || selected.size === 0}
              onClick={() => void approveSelected()}
            >
              {batchBusy ? "Aprobando…" : `Aprobar seleccionados (${selected.size})`}
            </Button>
            {batchMsg && <span className="text-xs text-muted-foreground">{batchMsg}</span>}
          </div>
        )}
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
        {actions.map((a) => {
          const hasPred = a.predHorizon != null && a.predP != null;
          const n10 = hasPred ? Math.round((a.predP ?? 0) * 10) : null;
          const nLow = hasPred && a.predPLow != null ? Math.round(a.predPLow * 10) : null;
          const nHigh = hasPred && a.predPHigh != null ? Math.round(a.predPHigh * 10) : null;
          const hecho = hasPred
            ? `ciclo ~${a.predCycleDays ?? "?"}d · lleva ${a.predTDays ?? "?"}d · ${ultimaCompraLabel} ${a.lastOrderAt ?? "—"}${a.lastOrderItems && a.lastOrderItems.length > 0 ? ` (${a.lastOrderItems.join(" · ")})` : ""}`
            : null;
          return (
          <Card key={a.id}>
            <CardContent className="flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {!isB2B && (
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggleSelect(a.id)}
                      aria-label={`Seleccionar borrador de ${a.name}`}
                      className="size-4 accent-primary"
                    />
                  )}
                  {a.name} <span className="font-normal text-muted-foreground">· {a.email}</span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {a.channel}
                  {a.kind ? ` · ${a.kind}` : ""}
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
                  {hasPred ? (
                    <>
                      <span>
                        <strong className="text-foreground">Hecho:</strong> {hecho}
                      </span>
                      <span>
                        <strong className="text-foreground">Evidencia:</strong> sin escribirle,
                        de cada 10 similares vuelven ~{n10} en {a.predHorizon}d (rango {nLow}–{nHigh})
                        {a.predConfidence === "baja" ? " (estimación inicial: aún hay pocos datos de esta tienda)" : ""}.
                      </span>
                      <span>
                        <strong className="text-foreground">Impacto:</strong> ticket esperado{" "}
                        {a.predTicketMinor != null ? formatMoney(a.predTicketMinor, shopCurrency) : "—"} · sin
                        descuento · canal {a.channel} ({a.channel === "whatsapp" ? "hay teléfono, se prefiere WhatsApp (≤400 chars)" : "sin teléfono a la vista, se usa email"}).
                      </span>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
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
          );
        })}
        {approvedActions.length > 0 && (
          <div className="mt-2 flex flex-col gap-3">
            <h3 className="text-sm font-medium">
              Aprobadas por enviar ({approvedActions.length})
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                salen con el dispatcher; revoca aquí si alguna ya no va
              </span>
            </h3>
            {approvedActions.map((a) => (
              <Card key={a.id}>
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[13px] font-medium">
                      {a.name} <span className="font-normal text-muted-foreground">· {a.email}</span>
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {a.channel}
                      {a.kind ? ` · ${a.kind}` : ""}
                      {a.generator !== COPYWRITER_GEN ? " · ⚠ criterios anteriores" : ""}
                    </span>
                  </div>
                  {a.subject && <p className="text-[13px] font-medium">{a.subject}</p>}
                  <p className="whitespace-pre-wrap text-[13px]">{a.body}</p>
                  <RevokeButton id={a.id} onRevoke={revokeApprovalAction} />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
      )}

      {visible.leads && active === "leads" && (
      <section className="flex flex-col gap-3" role="tabpanel">
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

      {visible.signals && active === "signals" && (
      <section className="flex flex-col gap-3" role="tabpanel">
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
