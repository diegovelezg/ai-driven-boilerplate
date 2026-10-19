"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, PenLine, Phone, Radar, Share2, UserPlus, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { SectionLoading } from "@/components/section-loading";
import { formatMoney } from "@/lib/medusa";
import { COPYWRITER_GEN } from "@/lib/copywriter-gen";
import { useBackgroundOrNull } from "@/components/background-status";
import {
  approveActionAction,
  approveBatchAction,
  approveLeadAction,
  dismissSignalAction,
  markDispatchedAction,
  regenerateStaleDraftsAction,
  rejectActionAction,
  rejectLeadAction,
  revokeApprovalAction,
  getDrawerCustomerAction,
  switchChannelAction,
  updateDraftContentAction,
} from "@/lib/review-actions";
import { ApprovePair, DismissButton, DraftActions, EditableDraft, MarkSentButton, RegenerateButton, RevokeButton } from "./review-buttons";
import { CustomerDrawer } from "../customers/customer-drawer";
import type { EditableCustomer } from "@/lib/customers-db";
import { approverLabel } from "@/lib/action-trace";

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
  /** Issue #19: auditoría de aprobación (null = sin registro, pre-migración). */
  approvedBy?: string | null;
  approvedAt?: string | null;
  /** Link wa.me con mensaje prellenado (whatsapp + teléfono normalizable). */
  wameUrl?: string | null;
  /** El cliente tiene email y WhatsApp: se ofrece cambiar de canal. */
  canSwitchChannel?: boolean;
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
    contacts?: {
      emails?: string[];
      phones?: string[];
      socials?: Array<{ network: string; url: string }>;
    };
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
  const tabs: Array<{ id: ReviewTab; label: string; show: boolean; icon: LucideIcon }> = [
    { id: "actions", label: `Mensajes por aprobar (${actions.length})`, show: visible.actions, icon: PenLine },
    { id: "leads", label: `Empresas por contactar (${leads.length})`, show: visible.leads, icon: UserPlus },
    { id: "signals", label: `Clientes en riesgo (${signals.length})`, show: visible.signals, icon: Radar },
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
  // Aprobación en lote (solo no-B2B) con corrida visible `approve_batch`
  // (Fase 3): progreso real en la cinta en vez del loop ciego.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchMsg, setBatchMsg] = useState<string | null>(null);
  const bg = useBackgroundOrNull();
  // SSR inicial + vivo del contexto: el snapshot solo ya no engaña cuando
  // una corrida arranca después del primer render.
  const liveKinds = new Set([
    ...runningKinds,
    ...(bg?.activeRuns.map((r) => r.kind) ?? []),
  ]);
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Ficha del cliente desde cualquier nombre/email de las cards.
  const [drawerCustomer, setDrawerCustomer] = useState<EditableCustomer | null>(null);
  const [drawerBusy, setDrawerBusy] = useState(false);
  const openDrawer = async (customerId?: string) => {
    if (!customerId || drawerBusy) return;
    setDrawerBusy(true);
    try {
      const r = await getDrawerCustomerAction(customerId);
      if (r.ok && r.customer) setDrawerCustomer(r.customer);
    } finally {
      setDrawerBusy(false);
    }
  };
  const approveSelected = async () => {
    if (batchBusy || selected.size === 0) return;
    setBatchBusy(true);
    setBatchMsg(null);
    try {
      const ids = [...selected];
      const r = bg
        ? await bg.start(async () => {
            const x = await approveBatchAction(ids);
            return { ok: x.ok, message: x.message, run: x.run ?? null };
          })
        : await approveBatchAction(ids);
      setBatchMsg(r.message);
      setSelected(new Set());
    } finally {
      setBatchBusy(false);
      router.refresh();
    }
  };
  const emptyActions = filtered
    ? "Sin resultados para ese filtro."
    : "Sin mensajes por aprobar. Pídelos en el chat o desde Overview.";
  const emptyLeads = filtered ? "Sin resultados para ese filtro." : "Sin empresas por contactar.";

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
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                active === t.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <t.icon className="size-4 shrink-0" aria-hidden />
              {t.label}
            </button>
          ))}
        </div>
      )}
      {visible.actions && active === "actions" && (
      <section className="flex flex-col gap-3" role="tabpanel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            Mensajes por aprobar ({actions.length})
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
          (liveKinds.has("copywriter") ? (
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
            <CardContent className="flex flex-col gap-3 px-4 pb-4">
              <div
                className="flex cursor-pointer flex-wrap items-center justify-between gap-2 rounded px-1 py-2 -mx-1 hover:bg-muted/40"
                title="Abrir ficha del cliente"
                onClick={() => void openDrawer(a.customerId)}
              >
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {!isB2B && (
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggleSelect(a.id)}
                      onClick={(e) => e.stopPropagation()}
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
              <EditableDraft
                key={`${a.id}-${a.body.length}-${a.subject ?? ""}`}
                id={a.id}
                channel={a.channel}
                subject={a.subject}
                body={a.body}
                onSave={updateDraftContentAction}
              />
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
              <DraftActions
                id={a.id}
                channel={a.channel}
                wameUrl={a.wameUrl}
                canSwitch={!!a.canSwitchChannel && (a.channel === "email" || a.channel === "whatsapp")}
                toLabel={a.channel === "email" ? "WhatsApp" : "Email"}
                onApprove={approveActionAction}
                onReject={rejectActionAction}
                onSwitch={switchChannelAction}
              />
            </CardContent>
          </Card>
          );
        })}
        {approvedActions.length > 0 && (
          <div className="mt-2 flex flex-col gap-3">
            <h3 className="text-sm font-medium">
              Aprobadas por enviar ({approvedActions.length})
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                los emails salieron al aprobar; WhatsApp es manual · cancela aquí el envío si alguno ya no va
              </span>
            </h3>
            {approvedActions.map((a) => (
              <Card key={a.id}>
                <CardContent className="flex flex-col gap-3 px-4 pb-4">
                  <div
                    className="flex cursor-pointer flex-wrap items-center justify-between gap-2 rounded px-1 py-2 -mx-1 hover:bg-muted/40"
                    title="Abrir ficha del cliente"
                    onClick={() => void openDrawer(a.customerId)}
                  >
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
                  <p className="text-xs text-muted-foreground tabular-nums">
                    Aprobado por {approverLabel(a.approvedBy)}
                    {a.approvedAt ? ` · ${a.approvedAt.slice(0, 10)}` : ""}
                  </p>
                  {a.channel === "whatsapp" ? (
                    <span className="flex flex-wrap items-center gap-2">
                      {a.wameUrl ? (
                        <AppTooltip tip="Abre el chat con el mensaje prellenado. Envías desde tu número.">
                          <Button
                            size="sm"
                            variant="outline"
                            render={<a href={a.wameUrl} target="_blank" rel="noopener noreferrer" />}
                            nativeButton={false}
                          >
                            Abrir en WhatsApp
                          </Button>
                        </AppTooltip>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Sin teléfono válido: revoca y genera la versión email.
                        </span>
                      )}
                      <MarkSentButton id={a.id} onMarkSent={markDispatchedAction} />
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No salió al aprobar · lo reintenta el dispatcher.
                    </span>
                  )}
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
          Empresas por contactar ({leads.length})
          {marketLabel && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              sin país atribuido: van todos
            </span>
          )}
        </h2>
        {leads.length === 0 &&
          (liveKinds.has("prospect") ? (
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
            <CardContent className="flex flex-col gap-3 px-4 pb-4">
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
              {(() => {
                const emails = l.evidence?.contacts?.emails ?? [];
                const phones = l.evidence?.contacts?.phones ?? [];
                const socials = l.evidence?.contacts?.socials ?? [];
                if (emails.length === 0 && phones.length === 0 && socials.length === 0) return null;
                return (
                  <div className="flex flex-col gap-1 text-xs">
                    {emails.length > 0 && (
                      <span className="flex items-center gap-1.5">
                        <Mail className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span>
                          {emails.map((e, i) => (
                            <span key={e}>
                              {i > 0 && ", "}
                              <a href={`mailto:${e}`} className="text-primary underline">{e}</a>
                            </span>
                          ))}
                        </span>
                      </span>
                    )}
                    {phones.length > 0 && (
                      <span className="flex items-center gap-1.5">
                        <Phone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span>
                          {phones.map((p, i) => (
                            <span key={p}>
                              {i > 0 && ", "}
                              <a href={`tel:${p.replace(/[^+\d]/g, "")}`} className="text-primary underline">{p}</a>
                            </span>
                          ))}
                        </span>
                      </span>
                    )}
                    {socials.length > 0 && (
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <Share2 className="size-3.5 shrink-0" aria-hidden />
                        <span>
                          {socials.map((s, i) => (
                            <span key={`${s.network}-${s.url}`}>
                              {i > 0 && " · "}
                              <a href={s.url} target="_blank" rel="noreferrer" className="text-primary underline">
                                {s.network}
                              </a>
                            </span>
                          ))}
                        </span>
                      </span>
                    )}
                  </div>
                );
              })()}
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
                    {(() => {
                      const nEmails = l.evidence?.contacts?.emails?.length ?? 0;
                      const nPhones = l.evidence?.contacts?.phones?.length ?? 0;
                      const nSocials = l.evidence?.contacts?.socials?.length ?? 0;
                      const hasAny = l.contact || nEmails > 0 || nPhones > 0 || nSocials > 0;
                      if (!hasAny) return "✗ sin contacto público (solo formulario)";
                      const bits: string[] = [];
                      if (l.contact) bits.push(`✓ contacto público: ${l.contact}`);
                      else bits.push("✓ contacto público detectado");
                      if (nEmails + nPhones + nSocials > 0)
                        bits.push(`${nEmails} email${nEmails === 1 ? "" : "s"} · ${nPhones} tel${nPhones === 1 ? "" : "s"} · ${nSocials} rrss`);
                      return bits.join(" · ");
                    })()} ·{" "}
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
        <h2 className="text-sm font-medium">Clientes en riesgo ({signals.length})</h2>
        {signals.length === 0 &&
          (liveKinds.has("scout") || liveKinds.has("strategist")) && (
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
      {drawerCustomer && (
        <CustomerDrawer
          key={drawerCustomer.dbId}
          customer={drawerCustomer}
          initialTab="compras"
          onClose={() => setDrawerCustomer(null)}
        />
      )}
    </>
  );
}
