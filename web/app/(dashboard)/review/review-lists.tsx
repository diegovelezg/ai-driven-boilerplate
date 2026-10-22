"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Mail, PenLine, Phone, Radar, Share2, UserPlus, type LucideIcon } from "lucide-react";
import { SectionHeading } from "@/components/section-heading";
import { cn } from "cn";
import { AppCard, AppCardState } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChannelTag, KindTag, ScoreTag, StatusTag, TodayTag } from "@/components/inbox-tag";
import { toast } from "@/components/ui/toast";
import { SectionLoading } from "@/components/section-loading";
import { formatMoney, formatNumber } from "@/lib/format";
import { COPYWRITER_GEN } from "@/lib/copywriter-gen";
import { useBackgroundOrNull } from "@/components/background-status";
import {
  approveActionAction,
  approveBatchAction,
  dismissSignalAction,
  markDispatchedAction,
  markLeadContactedAction,
  proposeSingleAction,
  reopenActionAction,
  reopenLeadAction,
  reopenSignalAction,
  regenerateStaleDraftsAction,
  rejectActionAction,
  rejectLeadAction,
  revokeApprovalAction,
  getDrawerCustomerAction,
  switchChannelAction,
  triggerProspectAction,
  updateDraftContentAction,
} from "@/lib/review-actions";
import { DismissButton, DraftActions, EditableDraft, MarkContactedButton, MarkSentButton, ProspectButton, RedactButton, RegenerateButton, ReopenButton, RescueButton, RevokeButton } from "./review-buttons";
import { PROSPECT_LEAD_CAP, PROSPECT_PAUSED_HINT, PROSPECT_B2B_ONLY_HINT } from "@/lib/prospect-cap";
import { FilterSearch } from "@/components/filter-search";
import { FilterToggleButton } from "@/components/filter-button";
import { CustomerDrawer } from "../customers/customer-drawer";
import type { EditableCustomer } from "@/lib/customers-db";
import { approverLabel } from "@/lib/action-trace";

/** Sustento colapsado (shadcn Collapsible BASIC, cerrado por defecto):
 *  el por-qué se propone no empuja el borrador hacia abajo. */
function Sustento({ children }: { children: ReactNode }) {
  return (
    <Collapsible className="rounded-lg bg-muted/40 px-3.5 py-2.5">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 text-left text-xs font-medium hover:text-foreground">
        Por qué se propone (sustento)
        <ChevronDown
          className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

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
  /** Tratamiento decidido por strategist (winback|nurture|vip_care); null = sin tratar. */
  objective?: string | null;
  score: number | null;
  reason: string | null;
  status: string;
  email: string;
  name: string;
  /** ISO de creación de la señal (tag "Hoy"; null = sin fecha). */
  createdAt?: string | null;
  customerId?: string;
  /** Días sin comprar (parseado del motivo; null = otros tipos). */
  daysSince?: number | null;
  ordersCount?: number | null;
  totalSpent?: number | null;
  currency?: string | null;
  /** Evidencia del motor (mismo sustento que "Mensajes por aprobar"). */
  predCycleDays?: number | null;
  predTDays?: number | null;
  predHorizon?: number | null;
  predP?: number | null;
  predPLow?: number | null;
  predPHigh?: number | null;
  predTicketMinor?: number | null;
  predValorMinor?: number | null;
  predConfidence?: string | null;
  lastOrderAt?: string | null;
  lastOrderItems?: string[] | null;
}

/** Tab del inbox: una cola por trabajo (retención vs adquisición vs contexto). */
export type ReviewTab = "actions" | "leads" | "signals";

/** Sustento de una señal (Clientes en riesgo): mismo Hecho/Evidencia/
 *  Impacto que "Mensajes por aprobar", sin canal (aún no hay borrador). */
function SignalSustento({
  s,
  shopCurrency,
  ultimaCompraLabel,
}: {
  s: SignalRow;
  shopCurrency?: string | null;
  ultimaCompraLabel: string;
}) {
  const hasPred = s.predHorizon != null && s.predP != null;
  const n10 = hasPred ? Math.round((s.predP ?? 0) * 10) : null;
  const nLow = hasPred && s.predPLow != null ? Math.round(s.predPLow * 10) : null;
  const nHigh = hasPred && s.predPHigh != null ? Math.round(s.predPHigh * 10) : null;
  const hecho = hasPred
    ? `ciclo ~${s.predCycleDays != null ? formatNumber(s.predCycleDays) : "?"}d · lleva ${s.predTDays != null ? formatNumber(s.predTDays) : "?"}d · ${ultimaCompraLabel} ${s.lastOrderAt ?? "—"}${s.lastOrderItems && s.lastOrderItems.length > 0 ? ` (${s.lastOrderItems.join(" · ")})` : ""}`
    : null;
  const historial =
    s.ordersCount != null || s.totalSpent != null || s.daysSince != null ? (
      <span>
        <strong className="text-foreground">Historial:</strong>{" "}
        {s.ordersCount != null ? `${formatNumber(s.ordersCount)} ${s.ordersCount === 1 ? "compra" : "compras"}` : "—"}
        {s.totalSpent != null ? ` · acumulado ${formatMoney(s.totalSpent, (s.currency ?? shopCurrency) ?? null)}` : ""}
        {s.daysSince != null ? ` · sin comprar hace ${formatNumber(s.daysSince)}d` : ""}.
      </span>
    ) : null;
  const treatment = s.objective ?? s.kind;
  return (
    <Sustento>
      {hasPred ? (
        <>
          <span>
            <strong className="text-foreground">Hecho:</strong> {hecho}
          </span>
          {historial}
          <span>
            <strong className="text-foreground">Evidencia:</strong> sin escribirle,
            de cada 10 similares vuelven ~{formatNumber(n10)} en {formatNumber(s.predHorizon)}d (rango {formatNumber(nLow)}–{formatNumber(nHigh)})
            {s.predConfidence === "baja" ? " (estimación inicial: aún hay pocos datos de esta tienda)" : ""}.
          </span>
          <span>
            <strong className="text-foreground">Impacto:</strong> ticket esperado{" "}
            {s.predTicketMinor != null ? formatMoney(s.predTicketMinor, shopCurrency ?? null) : "—"}
            {s.predValorMinor != null ? ` · valor esperado ${formatMoney(s.predValorMinor, shopCurrency ?? null)}` : ""} · sin
            descuento.
          </span>
        </>
      ) : (
        <>
          <span>
            <strong className="text-foreground">Regla:</strong>{" "}
            {treatment === "vip_care"
              ? "3+ compras y gasto en el top 20% → cuidado VIP, vale 1-a-1"
              : treatment === "winback"
                ? "1 sola compra y vencido → winback, la 2ª compra define si se queda"
                : treatment === "nurture"
                  ? "2+ compras, gasto medio → nurture, reactivar hábito"
                  : "señal de churn vencida → recupero"}{" "}
            {s.score != null ? `· score ${formatNumber(s.score)}` : ""} {s.reason ? `· ${s.reason}` : ""}
          </span>
          {historial}
          <span>
            El texto del futuro borrador usará solo historial real, sin cifras inventadas.
          </span>
        </>
      )}
    </Sustento>
  );
}

/** Listas del inbox: UN renderer para /review y para el canvas del chat.
 *  Recibe filas ya filtradas; `visible` decide qué secciones se muestran
 *  (con filtro del chat, solo lo pedido). Mutaciones por las mismas
 *  server actions en ambos hosts. */
export function ReviewLists({
  actions,
  approvedActions = [],
  rejectedActions = [],
  leads,
  /** Aprobados legacy aún no contactados: "Contactado" los cierra. */
  approvedLeads = [],
  /** Contactados y descartados: filtros visibles, nada desaparece para siempre. */
  contactedLeads = [],
  discardedLeads = [],
  signals,
  /** Descartadas recientes: "contactar igual" las reabre (issue #14 B3). */
  dismissedSignals = [],
  visible,
  runningKinds = [],
  marketLabel = null,
  /** ?market= activo: el botón prospecta segmentado a ese mercado. */
  marketId = null,
  customerDomains = null,
  shopCurrency = null,
  filtered = false,
  initialTab = "actions",
  ultimaCompraLabel = "última compra",
  /** true = tenant B2B: sin barra de aprobación en lote. Default seguro. */
  isB2B = true,
  /** Gate B2B del prospector: sin esto no hay botón (el backend veta igual). */
  prospectEligible = true,
}: {
  actions: ActionRow[];
  /** Aprobadas aún no enviadas: visibles para poder revocarlas. */
  approvedActions?: ActionRow[];
  /** Rechazadas/canceladas: visibles para rescatar si te arrepentiste. */
  rejectedActions?: ActionRow[];
  leads: LeadRow[];
  /** Aprobados legacy aún no contactados: "Contactado" los cierra. */
  approvedLeads?: LeadRow[];
  /** Contactados y descartados: filtros visibles, nada desaparece para siempre. */
  contactedLeads?: LeadRow[];
  discardedLeads?: LeadRow[];
  signals: SignalRow[];
  /** Descartadas recientes: "contactar igual" las reabre (issue #14 B3). */
  dismissedSignals?: SignalRow[];
  visible: { actions: boolean; leads: boolean; signals: boolean };
  runningKinds?: string[];
  marketLabel?: string | null;
  /** ?market= activo: el botón prospecta segmentado a ese mercado. */
  marketId?: string | null;
  /** null = sin verificar (canvas): se omite el check de duplicado. */
  customerDomains?: string[] | null;
  shopCurrency?: string | null;
  /** Filtro del chat activo: vacíos con mensaje de filtro, no de inbox. */
  filtered?: boolean;
  initialTab?: ReviewTab;
  ultimaCompraLabel?: string;
  isB2B?: boolean;
  /** Gate B2B del prospector: sin esto no hay botón (el backend veta igual). */
  prospectEligible?: boolean;
}) {
  const router = useRouter();
  const tabs: Array<{ id: ReviewTab; label: string; show: boolean; icon: LucideIcon }> = [
    { id: "actions", label: `Mensajes por aprobar (${formatNumber(actions.length)})`, show: visible.actions, icon: PenLine },
    { id: "leads", label: `Empresas por contactar (${formatNumber(leads.length)})`, show: visible.leads, icon: UserPlus },
    { id: "signals", label: `Clientes en riesgo (${formatNumber(signals.length)})`, show: visible.signals, icon: Radar },
  ];
  const shown = tabs.filter((t) => t.show);
  const fallback = shown[0]?.id ?? "actions";
  const [active, setActive] = useState<ReviewTab>(
    tabs.some((t) => t.id === initialTab && t.show) ? initialTab : fallback,
  );
  /** Sub-filtro de la pestaña leads: nada desaparece, se filtra arriba. */
  const [leadFilter, setLeadFilter] = useState<"pending" | "contacted" | "discarded">("pending");
  /** Sub-filtro de mensajes: mismo patrón que leads (nada desaparece). */
  const [actionFilter, setActionFilter] = useState<"pending" | "approved" | "rejected">("pending");
  /** Búsqueda libre local (empresa/dominio/url/contacto/motivo). */
  const [leadQuery, setLeadQuery] = useState("");
  const q = leadQuery.trim().toLowerCase();
  const matchLead = (l: LeadRow) =>
    q === "" ||
    [l.company, l.domain, l.url, l.contact, l.reason]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q);
  const shownLeads = leads.filter(matchLead);
  const shownApproved = approvedLeads.filter(matchLead);
  const shownContacted = contactedLeads.filter(matchLead);
  const shownDiscarded = discardedLeads.filter(matchLead);
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
      else if (!r.ok) toast.add({ title: "No se pudo abrir", description: r.message, type: "error" });
    } catch (e) {
      toast.add({
        title: "No se pudo abrir",
        description: e instanceof Error ? e.message : "Error inesperado.",
        type: "error",
      });
    } finally {
      setDrawerBusy(false);
    }
  };
  const approveSelected = async () => {
    if (batchBusy || selected.size === 0) return;
    setBatchBusy(true);
    try {
      const ids = [...selected];
      if (bg) {
        const r = await bg.start(async () => {
          const x = await approveBatchAction(ids);
          return { ok: x.ok, message: x.message, run: x.run ?? null };
        });
        // Con run la cinta ya avisa; sin run avisar aquí. La selección solo
        // se limpia en éxito: en fallo se conserva para reintentar.
        if (!r.run) {
          toast.add({
            title: r.ok ? "Lote aprobado" : "No se pudo aprobar el lote",
            description: r.message,
            type: r.ok ? "success" : "error",
          });
        }
        if (r.ok) setSelected(new Set());
      } else {
        const r = await approveBatchAction(ids);
        toast.add({
          title: r.ok ? "Lote aprobado" : "No se pudo aprobar el lote",
          description: r.message,
          type: r.ok ? "success" : "error",
        });
        if (r.ok) setSelected(new Set());
      }
    } catch (e) {
      toast.add({
        title: "No se pudo aprobar el lote",
        description: e instanceof Error ? e.message : "Error inesperado.",
        type: "error",
      });
    } finally {
      setBatchBusy(false);
      // Sin doble refresh: `bg.start()` ya refrescó al resolver; un segundo
      // refresh aborta el RSC en vuelo (ECONNRESET + parpadeo). Solo el host
      // sin provider (canvas) necesita refrescar aquí.
      if (!bg) router.refresh();
    }
  };
  const emptyActions = filtered
    ? "Sin resultados para ese filtro."
    : "Sin mensajes por aprobar. Pídelos en el chat o desde Overview.";
  const emptyLeads = filtered ? "Sin resultados para ese filtro." : "Sin empresas por contactar.";

  return (
    <>
      {shown.length > 1 && (
        <div role="tablist" aria-label="Colas de revisión" className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-muted/60 p-1.5">
          {shown.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={active === t.id}
              onClick={() => selectTab(t.id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors",
                active === t.id
                  ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <t.icon className="size-4 shrink-0" aria-hidden />
              {t.label}
            </button>
          ))}
        </div>
      )}
      {visible.actions && active === "actions" && (
      <section className="flex flex-col gap-4" role="tabpanel">
        <SectionHeading
          title={`Mensajes por aprobar (${formatNumber(actions.length)})`}
          hint="El Redactor propone; tú apruebas. Nada se envía sin tu visto bueno."
          tone="primary"
          right={
            <RegenerateButton
              count={actions.filter((a) => a.generator !== COPYWRITER_GEN).length}
              onRegenerate={regenerateStaleDraftsAction}
            />
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          {!filtered && (
            <>
              <FilterToggleButton active={actionFilter === "pending"} onClick={() => setActionFilter("pending")}>
                Pendientes ({formatNumber(actions.length)})
              </FilterToggleButton>
              <FilterToggleButton active={actionFilter === "approved"} onClick={() => setActionFilter("approved")}>
                Por enviar ({formatNumber(approvedActions.length)})
              </FilterToggleButton>
              <FilterToggleButton active={actionFilter === "rejected"} onClick={() => setActionFilter("rejected")}>
                Descartados ({formatNumber((rejectedActions ?? []).length)})
              </FilterToggleButton>
            </>
          )}
          {(filtered || actionFilter === "pending") && !isB2B && actions.some((a) => a.channel === "email") && (
            <span className="ml-auto">
              <Button
                size="sm"
                disabled={batchBusy || selected.size === 0}
                onClick={() => void approveSelected()}
              >
                <Mail className="size-4" aria-hidden />
                {batchBusy ? "Enviando…" : `Aprobar y enviar seleccionados (${formatNumber(selected.size)})`}
              </Button>
            </span>
          )}
        </div>
        {(filtered || actionFilter === "pending") && (
          <>
        {actions.length === 0 &&
          (liveKinds.has("copywriter") ? (
            <AppCardState>
              <SectionLoading label="borradores" />
            </AppCardState>
          ) : (
            <AppCardState>{emptyActions}</AppCardState>
          ))}
        {actions.map((a) => {
          const hasPred = a.predHorizon != null && a.predP != null;
          const n10 = hasPred ? Math.round((a.predP ?? 0) * 10) : null;
          const nLow = hasPred && a.predPLow != null ? Math.round(a.predPLow * 10) : null;
          const nHigh = hasPred && a.predPHigh != null ? Math.round(a.predPHigh * 10) : null;
          const hecho = hasPred
            ? `ciclo ~${a.predCycleDays != null ? formatNumber(a.predCycleDays) : "?"}d · lleva ${a.predTDays != null ? formatNumber(a.predTDays) : "?"}d · ${ultimaCompraLabel} ${a.lastOrderAt ?? "—"}${a.lastOrderItems && a.lastOrderItems.length > 0 ? ` (${a.lastOrderItems.join(" · ")})` : ""}`
            : null;
          return (
          <AppCard
            key={a.id}
            tone="primary"
            onHeaderClick={() => void openDrawer(a.customerId)}
            title={
              <span className="flex min-w-0 items-center gap-2">
                {!isB2B && a.channel === "email" && (
                  <input
                    type="checkbox"
                    checked={selected.has(a.id)}
                    onChange={() => toggleSelect(a.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Seleccionar borrador de ${a.name}`}
                    className="size-4 shrink-0 accent-primary"
                  />
                )}
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{a.name}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    · {a.email}
                  </span>
                </span>
              </span>
            }
            description={a.reason ? `Motivo: ${a.reason}` : undefined}
            action={
              <span className="flex items-center gap-1.5">
                <TodayTag value={a.created_at} />
                <ChannelTag value={a.channel} />
                <KindTag value={a.kind} />
              </span>
            }
            footer={
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
            }
            contentClassName="flex flex-col gap-3"
          >
              <EditableDraft
                key={`${a.id}-${a.body.length}-${a.subject ?? ""}`}
                id={a.id}
                channel={a.channel}
                subject={a.subject}
                body={a.body}
                onSave={updateDraftContentAction}
              />
              {/* Sustento colapsado: no empuja el borrador hacia abajo. */}
              <Sustento>
                  {hasPred ? (
                    <>
                      <span>
                        <strong className="text-foreground">Hecho:</strong> {hecho}
                      </span>
                      <span>
                        <strong className="text-foreground">Evidencia:</strong> sin escribirle,
                        de cada 10 similares vuelven ~{formatNumber(n10)} en {formatNumber(a.predHorizon)}d (rango {formatNumber(nLow)}–{formatNumber(nHigh)})
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
                        {a.score != null ? `· score ${formatNumber(a.score)}` : ""} {a.reason ? `· ${a.reason}` : ""}
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
              </Sustento>
            </AppCard>
          );
        })}
          </>
        )}
        {!filtered && actionFilter === "approved" && (
          <div className="mt-2 flex flex-col gap-4">
            <SectionHeading
              title={`Aprobadas por enviar (${formatNumber(approvedActions.length)})`}
              hint="Los emails salieron al aprobar; WhatsApp es manual. Cancela aquí si alguno ya no va."
              tone="emerald"
            />
            {approvedActions.length === 0 && (
              <AppCardState>Sin aprobadas por enviar.</AppCardState>
            )}
            {approvedActions.map((a) => (
              <AppCard
                key={a.id}
                tone="emerald"
                onHeaderClick={() => void openDrawer(a.customerId)}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{a.name}</span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      · {a.email}
                    </span>
                  </span>
                }
                description={
                  <span className="tabular-nums">
                    Aprobado por {approverLabel(a.approvedBy)}
                    {a.approvedAt ? ` · ${a.approvedAt.slice(0, 10)}` : ""}
                  </span>
                }
                action={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <TodayTag value={a.created_at} />
                    <ChannelTag value={a.channel} />
                    <KindTag value={a.kind} />
                    {a.generator !== COPYWRITER_GEN ? (
                      <span className="text-[11px] text-muted-foreground">⚠ criterios anteriores</span>
                    ) : null}
                  </span>
                }
                footer={
                  <span className="flex flex-wrap items-center gap-2">
                    {a.channel === "whatsapp" ? (
                      <>
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
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        No salió al aprobar · lo reintenta el dispatcher.
                      </span>
                    )}
                    <RevokeButton id={a.id} onRevoke={revokeApprovalAction} />
                  </span>
                }
                contentClassName="flex flex-col gap-3"
              >
                {a.subject && <p className="text-[13px] font-medium">{a.subject}</p>}
                <p className="whitespace-pre-wrap text-[13px]">{a.body}</p>
              </AppCard>
            ))}
          </div>
        )}
        {!filtered && actionFilter === "rejected" && (
          <div className="mt-2 flex flex-col gap-4">
            <SectionHeading
              title={`Descartados (${formatNumber((rejectedActions ?? []).length)})`}
              hint="Nada se pierde: rescata el que quieras devolver a Mensajes por aprobar."
              tone="amber"
            />
            {(rejectedActions ?? []).length === 0 && (
              <AppCardState>Sin descartados: lo que descartes aparece aquí y se puede rescatar.</AppCardState>
            )}
            {(rejectedActions ?? []).map((a) => (
              <AppCard
                key={a.id}
                tone="amber"
                onHeaderClick={() => void openDrawer(a.customerId)}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{a.name}</span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      · {a.email}
                    </span>
                  </span>
                }
                action={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <TodayTag value={a.created_at} />
                    <ChannelTag value={a.channel} />
                    <KindTag value={a.kind} />
                  </span>
                }
                footer={<RescueButton id={a.id} onRescue={reopenActionAction} />}
                contentClassName="flex flex-col gap-3"
              >
                {a.subject && <p className="text-[13px] font-medium">{a.subject}</p>}
                <p className="whitespace-pre-wrap text-[13px]">{a.body}</p>
              </AppCard>
            ))}
          </div>
        )}
      </section>
      )}

      {visible.leads && active === "leads" && (
      <section className="flex flex-col gap-4" role="tabpanel">
        <SectionHeading
          title={
            filtered
              ? `Empresas por contactar (${formatNumber(leads.length)})`
              : `Empresas por contactar (${formatNumber(leads.length)}/${formatNumber(PROSPECT_LEAD_CAP)})`
          }
          hint={
            !prospectEligible
              ? PROSPECT_B2B_ONLY_HINT
              : !filtered && leads.length >= PROSPECT_LEAD_CAP
                ? PROSPECT_PAUSED_HINT
                : "Negocios parecidos a tus mejores clientes, con contacto público."
          }
          tone="sky"
        />
        {!filtered && (
          <div className="flex flex-wrap items-center gap-2">
            <FilterSearch
              initialValue=""
              onSearch={setLeadQuery}
              placeholder="Buscar empresa, dominio o contacto…"
              ariaLabel="Buscar empresas"
            />
            <FilterToggleButton active={leadFilter === "pending"} onClick={() => setLeadFilter("pending")}>
              Pendientes ({formatNumber(leads.length + approvedLeads.length)})
            </FilterToggleButton>
            <FilterToggleButton active={leadFilter === "contacted"} onClick={() => setLeadFilter("contacted")}>
              Contactados ({formatNumber(contactedLeads.length)})
            </FilterToggleButton>
            <FilterToggleButton active={leadFilter === "discarded"} onClick={() => setLeadFilter("discarded")}>
              Descartados ({formatNumber(discardedLeads.length)})
            </FilterToggleButton>
            {prospectEligible ? (
              <span className="ml-auto">
                <ProspectButton onProspect={() => triggerProspectAction(marketId ?? null)} />
              </span>
            ) : undefined}
          </div>
        )}
        {(filtered || leadFilter === "pending") && (
          <>
        {shownLeads.length === 0 &&
          (q ? (
            <AppCardState>Sin resultados para esa búsqueda.</AppCardState>
          ) : liveKinds.has("prospect") ? (
            <AppCardState>
              <SectionLoading label="leads" rows={2} />
            </AppCardState>
          ) : (
            <AppCardState>{emptyLeads}</AppCardState>
          ))}
        {shownLeads.map((l) => (
          <AppCard
            key={l.id}
            tone="sky"
            title={l.company ?? l.domain ?? l.url}
            description={l.reason ?? undefined}
            action={
              l.icp_score != null || l.created_at ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <TodayTag value={l.created_at} />
                  <ScoreTag value={l.icp_score} />
                </span>
              ) : undefined
            }
            footer={
              <span className="flex items-center gap-2">
                <MarkContactedButton id={l.id} onMarkContacted={markLeadContactedAction} />
                <DismissButton id={l.id} onDismiss={rejectLeadAction} />
              </span>
            }
            contentClassName="flex flex-col gap-3"
          >
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
              <Sustento>
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
                          {s.orders != null ? ` en ${formatNumber(s.orders)} ${s.orders === 1 ? "compra" : "compras"}` : ""} ·{" "}
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
                        bits.push(`${formatNumber(nEmails)} email${nEmails === 1 ? "" : "s"} · ${formatNumber(nPhones)} tel${nPhones === 1 ? "" : "s"} · ${formatNumber(nSocials)} rrss`);
                      return bits.join(" · ");
                    })()} ·{" "}
                    afinidad {l.icp_score != null ? `${formatNumber(Math.round(l.icp_score * 100))}/100` : "?"} · {l.source ?? "searxng"}
                    {l.created_at ? ` · hallado ${l.created_at.slice(0, 10)}` : ""}
                  </span>
              </Sustento>
            </AppCard>
        ))}
        {shownApproved.length > 0 && (
          <div className="mt-2 flex flex-col gap-4">
            <SectionHeading
              title={`Aprobadas por contactar (${formatNumber(shownApproved.length)})`}
              hint="Ya les diste el visto bueno por fuera: márcalas cuando las contactes."
              tone="emerald"
            />
            {shownApproved.map((l) => (
              <AppCard
                key={l.id}
                tone="emerald"
                title={l.company ?? l.domain ?? l.url}
                description={l.reason ?? undefined}
                action={
                  l.icp_score != null ? (
                    <ScoreTag value={l.icp_score} />
                  ) : undefined
                }
                footer={<MarkContactedButton id={l.id} onMarkContacted={markLeadContactedAction} />}
                contentClassName="flex flex-col gap-3"
              >
                <a href={l.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
                  {l.url}
                </a>
                {(() => {
                  const emails = l.evidence?.contacts?.emails ?? [];
                  const phones = l.evidence?.contacts?.phones ?? [];
                  const socials = l.evidence?.contacts?.socials ?? [];
                  if (emails.length === 0 && phones.length === 0 && socials.length === 0) {
                    return l.contact ? (
                      <span className="text-xs">✓ contacto público: {l.contact}</span>
                    ) : null;
                  }
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
              </AppCard>
            ))}
          </div>
        )}
          </>
        )}
        {!filtered && leadFilter === "contacted" && (
          <>
            {shownContacted.length === 0 ? (
              <AppCardState>{q ? "Sin resultados para esa búsqueda." : "Sin contactados todavía: marca “Contactado” cuando escribas a una empresa."}</AppCardState>
            ) : (
          <div className="mt-2 flex flex-col gap-4">
            <SectionHeading
              title={`Contactados (${formatNumber(shownContacted.length)})`}
              hint="Ya los contactaste por tu cuenta. No se reproponen."
              tone="emerald"
            />
            {shownContacted.map((l) => (
              <AppCard
                key={l.id}
                tone="emerald"
                title={l.company ?? l.domain ?? l.url}
                description={l.reason ?? undefined}
                action={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <TodayTag value={l.created_at} />
                    <ScoreTag value={l.icp_score} />
                  </span>
                }
                contentClassName="flex flex-col gap-3"
              >
                <a href={l.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
                  {l.url}
                </a>
                {l.contact ? (
                  <span className="text-xs text-muted-foreground">✓ {l.contact}</span>
                ) : null}
              </AppCard>
            ))}
          </div>
            )}
          </>
        )}
        {!filtered && leadFilter === "discarded" && (
          <>
            {shownDiscarded.length === 0 ? (
              <AppCardState>{q ? "Sin resultados para esa búsqueda." : "Sin descartados: lo que descartes aparece aquí y se puede reabrir."}</AppCardState>
            ) : (
          <div className="mt-2 flex flex-col gap-4">
            <SectionHeading
              title={`Descartados (${formatNumber(shownDiscarded.length)})`}
              hint="Nada se pierde: reabre el que quieras contactar igual."
              tone="amber"
            />
            {shownDiscarded.map((l) => (
              <AppCard
                key={l.id}
                tone="amber"
                title={l.company ?? l.domain ?? l.url}
                description={l.reason ?? undefined}
                action={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <TodayTag value={l.created_at} />
                    <ScoreTag value={l.icp_score} />
                  </span>
                }
                footer={<ReopenButton id={l.id} onReopen={reopenLeadAction} />}
                contentClassName="flex flex-col gap-3"
              >
                <a href={l.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
                  {l.url}
                </a>
              </AppCard>
            ))}
          </div>
            )}
          </>
        )}
      </section>
      )}

      {visible.signals && active === "signals" && (
      <section className="flex flex-col gap-4" role="tabpanel">
        <SectionHeading
          title={`Clientes en riesgo (${formatNumber(signals.length)})`}
          hint="Señales abiertas del motor que todavía no tienen mensaje."
          tone="amber"
        />
        {signals.length === 0 &&
          (liveKinds.has("scout") || liveKinds.has("strategist")) && (
            <AppCardState>
              <SectionLoading label="señales" rows={2} />
            </AppCardState>
          )}
        {signals.map((s) => (
          <AppCard
            key={s.id}
            tone="amber"
            onHeaderClick={() => void openDrawer(s.customerId)}
            title={
              <span>
                {s.name} <span className="font-normal text-muted-foreground">· {s.email}</span>
              </span>
            }
            description={
              <span className="flex flex-wrap items-center gap-1.5">
                <TodayTag value={s.createdAt} />
                <StatusTag value={s.status} />
                <KindTag value={s.kind} />
                {s.score != null ? (
                  <span className="tabular-nums">score {formatNumber(s.score)}</span>
                ) : null}
                {s.reason ? <span className="basis-full">{s.reason}</span> : null}
              </span>
            }
            action={
              <span className="flex flex-wrap items-center gap-1.5">
                <RedactButton id={s.id} onRedact={proposeSingleAction} />
                <DismissButton id={s.id} onDismiss={dismissSignalAction} />
              </span>
            }
            contentClassName="flex flex-col gap-3"
          >
            <SignalSustento s={s} shopCurrency={shopCurrency} ultimaCompraLabel={ultimaCompraLabel} />
          </AppCard>
        ))}
        {(dismissedSignals ?? []).length > 0 && (
          <div className="mt-2 flex flex-col gap-3">
            <SectionHeading
              title={`Descartadas — ¿contactar igual? (${formatNumber((dismissedSignals ?? []).length)})`}
              hint="El descarte las escondía 30 días sin remedio. Reabrir las devuelve a la cola del motor."
              tone="emerald"
            />
            {(dismissedSignals ?? []).map((s) => (
              <AppCard
                key={s.id}
                tone="emerald"
                onHeaderClick={() => void openDrawer(s.customerId)}
                title={
                  <span>
                    {s.name} <span className="font-normal text-muted-foreground">· {s.email}</span>
                  </span>
                }
                description={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <TodayTag value={s.createdAt} />
                    <StatusTag value="dismissed" />
                    <KindTag value={s.kind} />
                    {s.score != null ? (
                      <span className="tabular-nums">score {formatNumber(s.score)}</span>
                    ) : null}
                    {s.reason ? <span className="basis-full">{s.reason}</span> : null}
                  </span>
                }
                action={<ReopenButton id={s.id} onReopen={reopenSignalAction} />}
                contentClassName="flex flex-col gap-3"
              >
                <SignalSustento s={s} shopCurrency={shopCurrency} ultimaCompraLabel={ultimaCompraLabel} />
              </AppCard>
            ))}
          </div>
        )}
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
