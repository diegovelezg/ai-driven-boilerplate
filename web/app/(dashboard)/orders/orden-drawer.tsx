"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Ban, Bot, CircleCheckBig, FileDown, FileText, Package, Paperclip, Pencil, PenLine, Receipt, Trash, X } from "lucide-react";
import { AppCard, AppCardState } from "@/components/app-card";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { DrawerShell, type DrawerTabDef } from "@/components/drawer-shell";
import { Button } from "@/components/ui/button";
import { AttachButton, DangerButton, DialogVolverButton, EditButton, RetryButton, RowIconButton, SubmitButton, CancelButton } from "@/components/buttons";
import { AttributeBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { OrderApprovalBadge, OrderAutorizadaBadge, OrderBillingBadge, OrderInvoiceBadge, OrderStageBadge } from "@/components/order-badges";
import { orderStageDisplay } from "@/lib/ui-badges";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DrawerDialogContent as DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { Steps } from "@/components/steps";
import { DrawerTable, DrawerTableBody, DrawerTableHeader, DrawerTableRow, DrawerTableTd, DrawerTableTh } from "@/components/drawer-table";
import { ORDER_STEPS, orderStage, orderTiming } from "@/lib/order-stage";
import { BILLING_LABELS, billingStatus, toBillingInvoice, invoicePaidMinor, aggregateCobranza } from "@/lib/billing-status";
import dynamic from "next/dynamic";
import { createAgencyOrderAction, signOrderAction, deleteAgencyOrderAction, attachCreativeAction, deleteCreativeAction, attachPhotoAction, deletePhotoAction, cancelOrderAction, reactivateOrderAction, deleteOrderAction, setInvoiceStatusAction } from "@/lib/order-flow-actions";

// Carga diferida: chat y forms solo se descargan al usarse. El drawer
// inicial no paga react-markdown/day-picker (análisis perf 2026-11-09:
// ~60 chunks en la primera apertura, micromark el más pesado).
function FormLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={label}>
      <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
    </div>
  );
}
const OrdenChat = dynamic(() => import("./orden-chat").then((m) => m.OrdenChat), {
  ssr: false,
  loading: () => <FormLoading label="Cargando chat" />,
});
const OrderEditForm = dynamic(() => import("./order-edit-form").then((m) => m.OrderEditForm), {
  ssr: false,
  loading: () => <FormLoading label="Cargando formulario" />,
});
const OrderLinesForm = dynamic(() => import("./order-lines-form").then((m) => m.OrderLinesForm), {
  ssr: false,
  loading: () => <FormLoading label="Cargando pantallas" />,
});
const InvoicePayments = dynamic(() => import("./invoice-payments").then((m) => m.InvoicePayments), {
  ssr: false,
  loading: () => <span className="text-xs text-muted-foreground">Cargando cobros…</span>,
});
const InvoiceForm = dynamic(() => import("./invoice-form").then((m) => m.InvoiceForm), {
  ssr: false,
  loading: () => <FormLoading label="Cargando factura" />,
});
import { hasMinRole, isMemberRole, type MemberRole } from "@/lib/roles";
import { normalizeCurrency } from "@/lib/currency";
import { effectiveOrderCommissionPct, splitAgencyAmounts } from "@/lib/agency-commission";
import type { OrderContactRef } from "@/lib/orders-db";
import { diffDaysInclusive, displayEndOfSafe, formatDate, formatDateTime, formatNumber, paymentTermsLabel, toTitleCase } from "@/lib/format";

interface Detail {
  order: Record<string, unknown>;
  advertiser_name: string | null;
  billing_name: string | null;
  billing_kind: string | null;
  billing_tax_id: string | null;
  billing_country: string | null;
  billing_commission_pct: number | null;
  billing_company_address: string | null;
  /** País del tenant (tasa IGV/IVA, SSOT `lib/tax-rate.ts`). */
  shop_country: string | null;
  agency_company_id: string | null;
  agency_name: string | null;
  agency_tax_id: string | null;
  agency_country: string | null;
  agency_commission_pct: number | null;
  lines: Array<Record<string, unknown>>;
  io_agency_orders: Array<Record<string, unknown>>;
  creatives: Array<Record<string, unknown>>;
  bookings_count: number;
  photos: Array<Record<string, unknown>>;
  photos_count: number;
  invoices: Array<Record<string, unknown>>;
  contacts: {
    billing: OrderContactRef | null;
    signer: OrderContactRef | null;
    payment: OrderContactRef | null;
    manager: OrderContactRef | null;
  };
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  signed: "Firmada",
  cancelled: "Cancelada",
};

function str(v: unknown): string {
  return typeof v === "string" && v ? v : "—";
}

function by(v: Record<string, unknown>): string | null {
  const a = v.created_by;
  return typeof a === "string" && a ? a : null;
}

/** Línea desde el contacto vinculado; null si no hay vínculo. */
function contactLine(ref: OrderContactRef | null | undefined): string | null {
  if (!ref) return null;
  return [ref.name, ref.role, ref.email].filter(Boolean).join(" · ") || null;
}

/**
 * Dialog genérico "pegar URL y adjuntar" (autorización / material / foto).
 * El input vive AQUÍ (estado local): escribir ya NO re-renderiza el drawer
 * (perf 2026-11-09: antes cada tecla reconciliaba tabla + cards + badges).
 */
function AttachUrlDialog({
  open,
  onOpenChange,
  title,
  description,
  inputId,
  emptyHint,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  inputId: string;
  emptyHint: string;
  pending: boolean;
  onConfirm: (url: string) => void;
}) {
  const [url, setUrl] = useState("");
  // Sin reset manual: el Portal desmonta al cerrar (keepMounted=false),
  // así que cada apertura parte de "".
  const confirm = () => {
    if (!url.trim()) {
      toast.add({ title: "Falta la URL", description: emptyHint, type: "error" });
      return;
    }
    onConfirm(url.trim());
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onOpenChange(false)}>
      <DialogContent className="w-auto max-w-[calc(100%-2rem)] sm:min-w-[420px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={inputId}>Adjunto (URL) *</Label>
            <Input
              id={inputId}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              inputMode="url"
              disabled={pending}
            />
          </div>
          <div className="flex justify-end gap-2">
            <CancelButton size="sm" onCancel={() => onOpenChange(false)} disabled={pending} />
            <SubmitButton size="sm" type="button" onClick={confirm} pending={pending} disabled={!url.trim()} pendingLabel="Adjuntando…">
              <Paperclip aria-hidden />
              Adjuntar
            </SubmitButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function OrdenDrawer({ orderId, myRole, onClose }: { orderId: string; myRole: MemberRole | null; onClose: () => void }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"resumen" | "produccion" | "cobranza" | "agentes">("resumen");
  const [editingFicha, setEditingFicha] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [signOpen, setSignOpen] = useState(false);
  const [omOpen, setOmOpen] = useState(false);
  const [matOpen, setMatOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [invOpen, setInvOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [linesOpen, setLinesOpen] = useState(false);
  const [linesNonce, setLinesNonce] = useState(0);
  const [screens, setScreens] = useState<Array<{ id: string; name: string; detail: string | null; code: string | null; price_pen: number | null }> | null>(null);
  const [screensError, setScreensError] = useState<string | null>(null);
  const [screensLoading, setScreensLoading] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error("No se pudo cargar la orden.");
      setDetail((await res.json()) as Detail);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : "No se pudieron cargar los datos.");
    }
  }, [orderId]);

  // Carga diferida: setState solo en callbacks async (patrón permitido por el lint).
  useEffect(() => {
    const ac = new AbortController();
    const h = setTimeout(() => {
      setTab("resumen");
      setDetail(null);
      setEditingFicha(false);
      void load(ac.signal);
    }, 0);
    return () => {
      clearTimeout(h);
      ac.abort();
    };
  }, [load]);

  const openLinesDialog = useCallback(async () => {
    setLinesOpen(true);
    setLinesNonce((n) => n + 1);
    if (screens !== null || screensLoading) return;
    setScreensLoading(true);
    setScreensError(null);
    try {
      const res = await fetch("/api/screens?limit=200", { cache: "no-store" });
      if (!res.ok) throw new Error("No se pudieron cargar las pantallas.");
      const data = (await res.json()) as { screens?: Array<{ id: string; name: string; detail: string | null; code: string | null; price_pen: number | null }> };
      setScreens(Array.isArray(data.screens) ? data.screens : []);
    } catch (e) {
      setScreensError(e instanceof Error ? e.message : "No se pudieron cargar las pantallas.");
    } finally {
      setScreensLoading(false);
    }
  }, [screens, screensLoading]);

  const doSign = () => {
    startTransition(async () => {
      const res = await signOrderAction({ orderId });
      if (res.ok) {
        toast.add({ title: "Orden firmada", description: res.message, type: "success" });
        setSignOpen(false);
        await load();
      } else {
        toast.add({ title: "No se pudo firmar", description: res.message, type: "error" });
      }
    });
  };

  const doCreateOm = (documentUrl: string) => {
    startTransition(async () => {
      const res = await createAgencyOrderAction({ orderId, documentUrl });
      if (res.ok) {
        toast.add({ title: "OM registrada", description: res.message, type: "success" });
        setOmOpen(false);
        await load();
      } else {
        toast.add({ title: "No se pudo registrar", description: res.message, type: "error" });
      }
    });
  };

  const runFlow = async (title: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    startTransition(async () => {
      const res = await fn();
      toast.add({ title, description: res.message, type: res.ok ? "success" : "error" });
      if (res.ok) await load();
    });
  };

  const doAttachMat = (fileUrl: string) => {
    startTransition(async () => {
      const res = await attachCreativeAction({
        orderId,
        fileUrl,
      });
      if (res.ok) {
        toast.add({ title: "Material adjuntado", description: res.message, type: "success" });
        setMatOpen(false);
        await load();
      } else {
        toast.add({ title: "No se pudo adjuntar", description: res.message, type: "error" });
      }
    });
  };

  const doAttachPhoto = (url: string) => {
    startTransition(async () => {
      const res = await attachPhotoAction({ orderId, url });
      if (res.ok) {
        toast.add({ title: "Adjunto guardado", description: res.message, type: "success" });
        setPhotoOpen(false);
        await load();
      } else {
        toast.add({ title: "No se pudo adjuntar", description: res.message, type: "error" });
      }
    });
  };

  const doCancelOrder = () => {
    startTransition(async () => {
      const res = await cancelOrderAction({ orderId });
      if (res.ok) {
        toast.add({ title: "Orden cancelada", description: res.message, type: "success" });
        setCancelOpen(false);
        await load();
      } else {
        toast.add({ title: "No se pudo cancelar", description: res.message, type: "error" });
      }
    });
  };

  const doReactivateOrder = () => {
    startTransition(async () => {
      const res = await reactivateOrderAction({ orderId });
      if (res.ok) {
        toast.add({ title: "Orden reactivada", description: res.message, type: "success" });
        setReactOpen(false);
        await load();
      } else {
        toast.add({ title: "No se pudo reactivar", description: res.message, type: "error" });
      }
    });
  };

  const doDeleteOrder = () => {
    startTransition(async () => {
      const res = await deleteOrderAction({ orderId });
      if (res.ok) {
        toast.add({ title: "Orden eliminada", description: res.message, type: "success" });
        setDelOpen(false);
        onClose();
        router.replace("/orders");
        router.refresh();
      } else {
        toast.add({ title: "No se pudo eliminar", description: res.message, type: "error" });
      }
    });
  };

  const o = detail?.order;
  const orderCurrency = normalizeCurrency((o as Record<string, unknown> | undefined)?.currency ?? "PEN");
  const lines = detail?.lines ?? [];
  const oms = detail?.io_agency_orders ?? [];
  const creatives = detail?.creatives ?? [];
  const photos = detail?.photos ?? [];
  const invoices = detail?.invoices ?? [];
  const pendingCreative = creatives.some((c) => c.qc_status !== "approved" || c.legal_status !== "approved");
  const gross = lines.reduce((a, l) => a + Number(l.rate_minor ?? 0), 0);
  const st = o
    ? orderStage({
        status: (o.status as string | null) ?? null,
        signed: o.status === "signed",
        hasOm: oms.length > 0,
        materialsOk: creatives.length > 0 && !pendingCreative,
        ...orderTiming(o, lines, nowMs),
        certified: (detail?.photos_count ?? 0) > 0,
      })
    : null;
  const bill = o
    ? billingStatus({
        gross_minor: gross,
        invoices: invoices.map(toBillingInvoice),
        starts_at: (o.starts_at as string | null) ?? null,
        payment_terms_days:
          typeof o.payment_terms_days === "number" ? (o.payment_terms_days as number) : null,
      })
    : null;

  const diasOi = o ? diffDaysInclusive(str(o.starts_at) === "—" ? null : o.starts_at, str(o.ends_at) === "—" ? null : o.ends_at) : null;
  const brand = typeof o?.brand === "string" && o.brand ? o.brand : null;
  const contratante = detail?.billing_name ?? null;
  const contratanteKind = detail?.billing_kind === "agencia" ? "Agencia" : detail?.billing_kind === "anunciante" ? "Anunciante" : null;
  const contactBillingLine = contactLine(detail?.contacts.billing);
  const contactSignerLine = contactLine(detail?.contacts.signer);
  // Sin responsable si la intermediaria es el contratante.
  const billingId = typeof o?.billing_company_id === "string" ? o.billing_company_id : null;
  const isAgencySelf = !!detail?.agency_company_id && detail.agency_company_id === billingId;
  const contactManagerLine = isAgencySelf ? null : contactLine(detail?.contacts.manager);
  const contactPaymentLine = contactLine(detail?.contacts.payment);
  const ended = o ? orderTiming(o, lines, nowMs).ended : false;
  const nextAction: string | null = !st
    ? null
    : st.stage === "cancelada"
      ? "Orden cancelada: revisa los saldos de cobranza que sigan pendientes."
      : st.stage === "atrasada"
        ? "La fecha de inicio ya llegó: falta autorización o material aprobado. Revisa la salida con el operador."
        : st.stage === "programada"
          ? "Preparada para el próximo período contratado. La emisión se indica según las fechas de pauta."
      : st.index === 0
        ? "Borrador: falta la firma del cliente para avanzar."
        : st.index === 1
          ? "Firmada: adjunta la autorización para pasar a Materiales."
          : st.stage === "materiales"
            ? "En Materiales: falta aprobar QC + legal de todas las piezas."
            : st.stage === "al_aire"
              ? `En período de emisión previsto${o?.ends_at ? ` hasta el ${formatDate(o.ends_at)}` : ""}: el cobro corre en paralelo.`
              : st.stage === "por_certificar"
                ? "Terminó la pauta: sube el foto check / PoP para cerrar."
                : "Ciclo operativo completo. Revisa que el cobro esté en Pagado.";
  const progress = bill && gross > 0 ? Math.min(100, Math.round((bill.paid_minor / gross) * 100)) : 0;
  const isDraft = String(o?.status ?? "") === "draft";
  const isCancelled = String(o?.status ?? "") === "cancelled";
  // Sin auth (dev: myRole null) se permite editar; viewer = solo lectura.
  const canEditRole = myRole === null || (isMemberRole(myRole) && hasMinRole(myRole, "seller"));
  const canEdit = canEditRole && !isCancelled;
  // Eliminar: solo owner (como pantallas), en borrador o cancelada.
  const canDelete = myRole === null || (isMemberRole(myRole) && hasMinRole(myRole, "owner"));
  const canDeleteOrder = canDelete && (isDraft || isCancelled);
  // Override de comisión por orden: solo admin (como el default por empresa).
  const canEditCommission = myRole === null || (isMemberRole(myRole) && hasMinRole(myRole, "admin"));
  // Comisión informativa (no mueve cobranza): override > intermediaria
  // vinculada > billing si es agencia > 0.
  const commissionPct = detail
    ? effectiveOrderCommissionPct({
        ioOverride: detail.order.commission_pct ?? null,
        agencyCompanyPct: detail.agency_commission_pct ?? null,
        billingKind: detail.billing_kind ?? null,
        billingCompanyPct: detail.billing_commission_pct ?? null,
      })
    : 0;
  const commissionSplit = gross > 0 && commissionPct > 0 ? splitAgencyAmounts(gross, commissionPct) : null;
  const drawerTabs: DrawerTabDef[] = [
    { id: "resumen", label: "Resumen", icon: FileText },
    { id: "produccion", label: "Producción", icon: Package },
    { id: "cobranza", label: `Cobranza (${invoices.length})`, icon: Receipt },
    { id: "agentes", label: "Agentes", icon: Bot },
  ];

  return (
    <DrawerShell
      onClose={onClose}
      size="wide"
      avatar={<FileText className="size-5" aria-hidden />}
      title={o ? String(o.io_number ?? "Orden") : "Orden"}
      description={o ? [contratante ? toTitleCase(contratante) : null, brand ? toTitleCase(brand) : null].filter(Boolean).join(" · ") || "—" : "Cargando…"}
      badges={
        st && (
          <span className="flex flex-wrap items-center gap-1.5" aria-label={`Etapa ${orderStageDisplay(st.stage, isDraft).label}${oms.length > 0 ? ", autorizada" : ""}${bill ? `, cobro ${BILLING_LABELS[bill.status]}` : ""}`}>
            <OrderStageBadge stage={st.stage} isDraft={isDraft} />
            {oms.length > 0 && st.stage !== "cancelada" && <OrderAutorizadaBadge />}
            {bill && <OrderBillingBadge status={bill.status} prepaid={bill.isPrepaid} prefixed />}
            {(canEditRole || canDelete) && (
              <span className="ms-auto flex items-center gap-1">
                {isCancelled ? (
                  canEditRole && (
                    <AppTooltip tip="Reactivar orden (vuelve a borrador)">
                      <RowIconButton
                        icon={CircleCheckBig}
                        label="Reactivar orden"
                        title="Reactivar"
                        disabled={isPending}
                        pending={isPending}
                        onClick={() => setReactOpen(true)}
                      />
                    </AppTooltip>
                  )
                ) : (
                  canEdit &&
                  !isDraft && (
                    <AppTooltip tip="Cancelar orden">
                      <RowIconButton
                        icon={Ban}
                        label="Cancelar orden"
                        title="Cancelar"
                        danger
                        disabled={isPending}
                        pending={isPending}
                        onClick={() => setCancelOpen(true)}
                      />
                    </AppTooltip>
                  )
                )}
                {canDeleteOrder && (
                  <AppTooltip tip="Eliminar orden (solo propietario)">
                    <RowIconButton
                      icon={Trash}
                      label="Eliminar orden"
                      title="Eliminar (solo propietario)"
                      danger
                      disabled={isPending}
                      pending={isPending}
                      onClick={() => setDelOpen(true)}
                    />
                  </AppTooltip>
                )}
              </span>
            )}
          </span>
        )
      }
      tabs={drawerTabs}
      tab={tab}
      onTabChange={(id) => setTab(id as typeof tab)}
      tabListLabel="Detalle de la orden"
      fill={tab === "agentes"}
    >
      {tab === "agentes" ? (
        <OrdenChat orderId={orderId} orderLabel={o ? String(o.io_number ?? "Orden") : "Orden"} />
      ) : (
      <>
      {error && (
        <div className="flex flex-col gap-3">
          <AppCardState>{error}</AppCardState>
          <RetryButton onRetry={() => void load()} />
        </div>
      )}
      {!error && !detail && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando orden">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
        </div>
      )}

      {detail && o && st && (
        <>
          {st.index >= 0 && (
            <section aria-label="Avance operativo" className="flex flex-col gap-2">
              <Steps steps={[...ORDER_STEPS]} current={st.index} />
              {nextAction && (
                <p className="text-xs leading-relaxed text-muted-foreground" aria-live="polite">
                  {nextAction}
                </p>
              )}
            </section>
          )}

          {tab === "resumen" && (
          <>
          {isDraft && canEdit && (
            <section aria-label="Firmar orden" className="flex flex-col gap-2 rounded-xl bg-muted/40 px-4 py-3">
              <p className="text-sm font-medium">Borrador: esperando la firma del cliente</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Cuando el cliente firme la orden, márcala aquí. Recién entonces podrás registrar el OM/OC.
              </p>
              <div className="flex flex-wrap gap-2">
                <SubmitButton size="sm" type="button" onClick={() => setSignOpen(true)} disabled={isPending}>
                  <PenLine aria-hidden />
                  Marcar firmada
                </SubmitButton>
                <Button variant="outline" size="sm" render={<Link href={`/orders/${orderId}/print`} target="_blank" rel="noreferrer" />} nativeButton={false}>
                  <FileDown aria-hidden />
                  Exportar PDF
                </Button>
              </div>
            </section>
          )}
          {editingFicha && canEdit && isDraft ? (
              <OrderEditForm
                key={orderId}
                orderId={orderId}
                initial={{
                  brand: typeof o.brand === "string" ? o.brand : "",
                  payment_terms_days: typeof o.payment_terms_days === "number" ? String(o.payment_terms_days) : "",
                  notes: typeof o.notes === "string" ? o.notes : "",
                  doc_orden_medios: o.doc_orden_medios === true,
                  doc_orden_compra: o.doc_orden_compra === true,
                  doc_contrato: o.doc_contrato === true,
                  billing_company_id: typeof o.billing_company_id === "string" ? o.billing_company_id : "",
                  billing_portal_email: typeof o.billing_portal_email === "string" ? o.billing_portal_email : "",
                  billing_detail: typeof o.billing_detail === "string" ? o.billing_detail : "",
                  invoice_registration: typeof o.invoice_registration === "string" ? o.invoice_registration : "",
                  agency_company_id: typeof o.agency_company_id === "string" ? o.agency_company_id : "",
                  commission_pct: o.commission_pct === null || o.commission_pct === undefined || o.commission_pct === "" ? "" : String(o.commission_pct),
                  billing_contact_id: typeof o.billing_contact_id === "string" ? o.billing_contact_id : "",
                  signer_contact_id: typeof o.signer_contact_id === "string" ? o.signer_contact_id : "",
                  payment_contact_id: typeof o.payment_contact_id === "string" ? o.payment_contact_id : "",
                  manager_contact_id: typeof o.manager_contact_id === "string" ? o.manager_contact_id : "",
                }}
                canEditCommission={canEditCommission}
                onSaved={() => {
                  setEditingFicha(false);
                  router.refresh();
                  void load();
                }}
                onCancel={() => setEditingFicha(false)}
              />
            ) : (
            <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold tracking-tight">Ficha</h2>
                <p className="text-xs text-muted-foreground">Anunciante, contratante, marca, periodo, facturación e intermediario.</p>
              </div>
              <span className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" render={<Link href={`/orders/${orderId}/print`} target="_blank" rel="noreferrer" />} nativeButton={false} aria-label="Exportar borrador a PDF">
                  <FileDown className="size-3.5" aria-hidden /> PDF
                </Button>
                {canEdit && isDraft && (
                  <EditButton onEdit={() => setEditingFicha(true)} />
                )}
              </span>
            </div>
            <AppCard title="Contratante" aria-label="Contratante de la orden" tone="sky">
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Contratante</dt><dd className="mt-1 text-sm font-medium">{contratante ? `${toTitleCase(contratante)}${contratanteKind ? ` · ${contratanteKind}` : ""}` : "—"}</dd></div>
              {detail?.advertiser_name && (
                <div><dt className="text-xs text-muted-foreground">Anunciante</dt><dd className="mt-1 text-sm font-medium">{toTitleCase(detail.advertiser_name)}</dd></div>
              )}
              <div><dt className="text-xs text-muted-foreground">Marca</dt><dd className="mt-1 text-sm">{brand ? toTitleCase(brand) : "—"}</dd></div>
              <div>
                <dt className="text-xs text-muted-foreground">Periodo</dt>
                <dd className="mt-1 text-sm tabular-nums">
                  {o.starts_at && o.ends_at
                    ? `${formatDate(o.starts_at)} → ${formatDate(o.ends_at)}${diasOi ? ` · ${formatNumber(diasOi)} días` : ""}`
                    : "—"}
                </dd>
              </div>
              <div><dt className="text-xs text-muted-foreground">Bruto</dt><dd className="mt-1 text-sm font-semibold tabular-nums">{gross > 0 ? <Money amountMinor={gross} currency={orderCurrency} /> : "—"}</dd></div>
              {commissionSplit && (
                <>
                  <div><dt className="text-xs text-muted-foreground">Comisión agencia ({commissionPct}%)</dt><dd className="mt-1 text-sm tabular-nums"><Money amountMinor={commissionSplit.commissionMinor} currency={orderCurrency} /></dd></div>
                  <div><dt className="text-xs text-muted-foreground">Neto</dt><dd className="mt-1 text-sm tabular-nums"><Money amountMinor={commissionSplit.netMinor} currency={orderCurrency} /> <span className="text-xs font-normal text-muted-foreground">informativo</span></dd></div>
                </>
              )}
              <div><dt className="text-xs text-muted-foreground">Condición de pago</dt><dd className="mt-1 text-sm">{typeof o.payment_terms_days === "number" ? paymentTermsLabel(o.payment_terms_days) : str(o.payment_terms)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Estado</dt><dd className="mt-1 text-sm">{STATUS_LABEL[String(o.status ?? "")] ?? str(o.status)}</dd></div>
              {contactBillingLine && (
                <div><dt className="text-xs text-muted-foreground">Contacto</dt><dd className="mt-1 text-sm">{contactBillingLine}</dd></div>
              )}
              {contactSignerLine && (
                <div><dt className="text-xs text-muted-foreground">Firmante</dt><dd className="mt-1 text-sm">{contactSignerLine}</dd></div>
              )}
              {typeof o.notes === "string" && o.notes.trim() && (
                <div><dt className="text-xs text-muted-foreground">Notas</dt><dd className="mt-1 text-sm">{o.notes.trim()}</dd></div>
              )}
              <div><dt className="text-xs text-muted-foreground">Firma</dt><dd className="mt-1 text-sm tabular-nums">{o.signed_at ? formatDateTime(o.signed_at) : "—"}</dd></div>
              <div>
                <dt className="text-xs text-muted-foreground">Creada</dt>
                <dd className="mt-1 text-sm tabular-nums">{o.created_at ? formatDateTime(o.created_at) : "—"}{o.created_by ? ` · ${str(o.created_by)}` : ""}</dd>
              </div>
              {typeof o.updated_at === "string" && o.updated_at && o.updated_at !== o.created_at && (
                <div>
                  <dt className="text-xs text-muted-foreground">Actualizada</dt>
                  <dd className="mt-1 text-sm tabular-nums">{formatDateTime(o.updated_at)}{typeof o.updated_by === "string" && o.updated_by ? ` · ${o.updated_by}` : ""}</dd>
                </div>
              )}
            </dl>
            </AppCard>
            <AppCard title="Facturación" aria-label="Facturación de la orden" tone="violet">
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
              {(o.doc_orden_medios === true || o.doc_orden_compra === true || o.doc_contrato === true) && (
                <div><dt className="text-xs text-muted-foreground">Documento</dt><dd className="mt-1 text-sm">{[
                  o.doc_orden_medios === true ? "Orden de Medios" : null,
                  o.doc_orden_compra === true ? "Orden de Compra" : null,
                  o.doc_contrato === true ? "Contrato" : null,
                ].filter(Boolean).join(" + ")}</dd></div>
              )}
              {contactPaymentLine && (
                <div><dt className="text-xs text-muted-foreground">Contacto de pago</dt><dd className="mt-1 text-sm">{contactPaymentLine}</dd></div>
              )}
              {typeof o.billing_portal_email === "string" && o.billing_portal_email.trim() && (
                <div><dt className="text-xs text-muted-foreground">Correo / Portal</dt><dd className="mt-1 text-sm">{o.billing_portal_email}</dd></div>
              )}
              {typeof o.billing_detail === "string" && o.billing_detail.trim() && (
                <div><dt className="text-xs text-muted-foreground">Indicaciones de facturación</dt><dd className="mt-1 text-sm">{o.billing_detail}</dd></div>
              )}
              {typeof o.invoice_registration === "string" && o.invoice_registration.trim() && (
                <div><dt className="text-xs text-muted-foreground">Obs. registro de factura</dt><dd className="mt-1 text-sm">{o.invoice_registration}</dd></div>
              )}
              {detail?.billing_company_address && (
                <div><dt className="text-xs text-muted-foreground">Dirección</dt><dd className="mt-1 text-sm">{detail.billing_company_address}</dd></div>
              )}
            </dl>
            </AppCard>
            <AppCard title="Intermediario" aria-label="Intermediario de la orden" tone="emerald">
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
              {detail?.agency_name && (
                <div><dt className="text-xs text-muted-foreground">Intermediario</dt><dd className="mt-1 text-sm">{[detail.agency_name, detail.agency_tax_id].filter(Boolean).join(" · ")}{detail.agency_commission_pct !== null && detail.agency_commission_pct !== undefined ? ` · ${detail.agency_commission_pct}%` : ""}</dd></div>
              )}
              {contactManagerLine && (
                <div><dt className="text-xs text-muted-foreground">Responsable</dt><dd className="mt-1 text-sm">{contactManagerLine}</dd></div>
              )}
            </dl>
            </AppCard>
            </>
          )}

          <>
          {isDraft && canEdit && lines.length > 0 && (
            <div className="flex justify-end">
              <EditButton onEdit={() => void openLinesDialog()} disabled={isPending} />
            </div>
          )}
          <AppCard
            title={`Pantallas (${lines.length})`}
            tone="primary"
            aria-label="Pantallas de la orden"
          >
          {lines.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
              <p className="text-sm text-muted-foreground">Sin pantallas en esta orden.</p>
              {isDraft && canEdit && (
                <div>
                  <SubmitButton size="sm" type="button" onClick={() => void openLinesDialog()} disabled={isPending}>
                    <Pencil className="size-3.5" aria-hidden /> Agregar pantallas
                  </SubmitButton>
                </div>
              )}
            </div>
          ) : (
              <DrawerTable flush>
                <DrawerTableHeader flush>
                  <DrawerTableTh>Pantalla</DrawerTableTh>
                  <DrawerTableTh>Periodo</DrawerTableTh>
                  <DrawerTableTh numeric>Días</DrawerTableTh>
                  <DrawerTableTh numeric>Slots</DrawerTableTh>
                  <DrawerTableTh numeric>Total</DrawerTableTh>
                </DrawerTableHeader>
                <DrawerTableBody>
                  {lines.map((l) => {
                    const finIncl = displayEndOfSafe(l.ends_at);
                    const dias = typeof l.cant_dias === "number" && l.cant_dias > 0
                      ? l.cant_dias
                      : diffDaysInclusive(typeof l.starts_at === "string" ? l.starts_at : null, finIncl);
                    const regular = Number(l.tarifa_regular_minor ?? NaN);
                    return (
                      <DrawerTableRow key={String(l.id)}>
                        <DrawerTableTd className="font-medium">
                          {str(l.screen_name)}
                          {typeof l.screen_detail === "string" && l.screen_detail && (
                            <span className="block max-w-[280px] truncate text-xs font-normal text-muted-foreground">{l.screen_detail}</span>
                          )}
                          {typeof l.notes === "string" && l.notes && (
                            <span className="block text-xs font-normal text-muted-foreground">{l.notes}</span>
                          )}
                          {Number.isFinite(regular) && regular > 0 && regular !== Number(l.rate_minor ?? 0) && (
                            <span className="block text-xs font-normal text-muted-foreground tabular-nums">
                              Reg. <Money amountMinor={regular} currency={orderCurrency} />
                            </span>
                          )}
                        </DrawerTableTd>
                        <DrawerTableTd className="text-xs tabular-nums">
                          {formatDate(l.starts_at)} → {finIncl ? formatDate(finIncl) : "—"}
                        </DrawerTableTd>
                        <DrawerTableTd numeric className="text-xs tabular-nums">
                          {dias ?? "—"}
                        </DrawerTableTd>
                        <DrawerTableTd numeric className="text-xs tabular-nums">
                          {typeof l.cant_slots === "number" && l.cant_slots >= 1 ? l.cant_slots : 1}
                        </DrawerTableTd>
                        <DrawerTableTd numeric className="tabular-nums">
                          <Money amountMinor={l.rate_minor as number} currency={orderCurrency} />
                        </DrawerTableTd>
                      </DrawerTableRow>
                    );
                  })}
                  <DrawerTableRow className="bg-muted/30 font-medium">
                    <DrawerTableTd colSpan={4}>
                      Total · {formatNumber(lines.length)} pantalla{lines.length === 1 ? "" : "s"}
                    </DrawerTableTd>
                    <DrawerTableTd numeric className="tabular-nums">
                      {gross > 0 ? <Money amountMinor={gross} currency={orderCurrency} /> : "—"}
                    </DrawerTableTd>
                  </DrawerTableRow>
                </DrawerTableBody>
              </DrawerTable>
            )}
            <p className="text-xs text-muted-foreground">
              Una vez firmada, las pantallas ya no se pueden modificar: solo queda cancelar la orden y generar otra.
            </p>
          </AppCard>
          </>
            {isCancelled && canEditRole && (
              <div>
                <SubmitButton size="sm" type="button" onClick={() => setReactOpen(true)} disabled={isPending}>
                  <CircleCheckBig aria-hidden />
                  Reactivar orden
                </SubmitButton>
              </div>
            )}
            {canEdit && !isDraft && (
              <div>
                <DangerButton onClick={() => setCancelOpen(true)} disabled={isPending}>
                  <Ban aria-hidden />
                  Cancelar orden
                </DangerButton>
              </div>
            )}
            </>
          )}

          {tab === "produccion" && (
          <>
          <AppCard
            title={`Autorización (${oms.length})`}
            description="Autorización de la agencia. Sin ella, la orden no avanza a producción."
            action={
              canEdit && !isDraft && oms.length > 0 ? (
                <AttachButton placement="card" onAttach={() => setOmOpen(true)} disabled={isPending} />
              ) : undefined
            }
            tone="sky"
            aria-label="Autorización"
          >
            {oms.length === 0 ? (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="text-sm text-muted-foreground">
                  {isDraft
                    ? "Primero marca la orden como firmada; luego adjunta la autorización."
                    : "Sin OM/OC registrado. La autorización es el hito que libera Materiales."}
                </p>
                {canEdit && !isDraft && (
                  <div>
                    <AttachButton onAttach={() => setOmOpen(true)} disabled={isPending} />
                  </div>
                )}
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {oms.map((m) => {
                  const doc = typeof m.document_url === "string" && m.document_url ? m.document_url : null;
                  const rawCode = str(m.code);
                  const codeIsUrl = /^https?:\/\//i.test(rawCode);
                  const href = doc ?? (codeIsUrl ? rawCode : null);
                  return (
                  <li key={String(m.id)} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <AttributeBadge label={str(m.kind)} title="Tipo de material" />
                      {!codeIsUrl && <span className="truncate font-medium">{rawCode}</span>}
                      {href && (
                        <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-primary underline-offset-4 hover:underline">
                          Adjunto
                        </a>
                      )}
                      {by(m) && (
                        <span className="shrink-0 truncate text-xs text-muted-foreground" title={`Agregado por ${by(m)}`}>{by(m)}</span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {canEdit && (
                        <RowIconButton
                          icon={X}
                          label={`Eliminar ${str(m.kind)} ${rawCode}`}
                          title="Eliminar (por error al registrar)"
                          disabled={isPending}
                          pending={isPending}
                          onClick={() => void runFlow("OM eliminado", () => deleteAgencyOrderAction({ agencyOrderId: String(m.id) }))}
                        />
                      )}
                    </span>
                  </li>
                  );
                })}
              </ul>
            )}
          </AppCard>

          <AppCard
            title={`Materiales (${creatives.length})`}
            description="Adjunta la pieza; queda aprobada y libera la salida al aire."
            action={
              canEdit && creatives.length > 0 ? (
                <AttachButton placement="card" onAttach={() => setMatOpen(true)} disabled={isPending} />
              ) : undefined
            }
            tone="violet"
            aria-label="Materiales"
          >
            {creatives.length === 0 ? (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="text-sm text-muted-foreground">
                  Sin piezas cargadas. Adjunta el material para pasar a emisión.
                </p>
                {canEdit && (
                  <div>
                    <AttachButton onAttach={() => setMatOpen(true)} disabled={isPending} />
                  </div>
                )}
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {creatives.map((c) => {
                  const file = typeof c.file_url === "string" && c.file_url ? c.file_url : null;
                  const ok = String(c.qc_status ?? "") === "approved" && String(c.legal_status ?? "") === "approved";
                  const cw = Number(c.width_px);
                  const ch = Number(c.height_px);
                  const cd = Number(c.duration_s);
                  const spec = [
                    Number.isFinite(cw) && Number.isFinite(ch) && cw > 0 && ch > 0
                      ? `${Math.round(cw)}×${Math.round(ch)}${typeof c.aspect === "string" && c.aspect ? ` (${c.aspect})` : ""}`
                      : null,
                    Number.isFinite(cd) && cd > 0 ? `${cd} s` : null,
                  ].filter(Boolean).join(" · ");
                  return (
                  <li key={String(c.id)} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {str(c.name)}
                      {spec && (
                        <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{spec}</span>
                      )}
                      {file && (
                        <>{" "}<a href={file} target="_blank" rel="noreferrer" className="text-xs font-normal text-primary underline-offset-4 hover:underline">
                          Adjunto
                        </a></>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {by(c) && (
                        <span className="hidden truncate text-xs text-muted-foreground md:block" title={`Agregado por ${by(c)}`}>{by(c)}</span>
                      )}
                      <OrderApprovalBadge approved={ok} />
                      {canEdit && (
                        <RowIconButton
                          icon={X}
                          label={`Eliminar ${str(c.name)}`}
                          title="Eliminar (por error al adjuntar)"
                          disabled={isPending}
                          pending={isPending}
                          onClick={() => void runFlow("Material eliminado", () => deleteCreativeAction({ creativeId: String(c.id) }))}
                        />
                      )}
                    </span>
                  </li>
                  );
                })}
              </ul>
            )}
          </AppCard>

          <AppCard
            title={`Certificación (${photos.length})`}
            description="Evidencia fotográfica de la pauta al aire. Corre en paralelo a la cobranza."
            action={
              canEdit && photos.length > 0 ? (
                <AttachButton placement="card" onAttach={() => setPhotoOpen(true)} disabled={isPending} />
              ) : undefined
            }
            tone="emerald"
            aria-label="Certificación"
          >
            {photos.length === 0 && canEdit && (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="text-sm text-muted-foreground">
                  {ended
                    ? "La pauta terminó sin foto check: adjúntalo para cerrar el ciclo operativo."
                    : "Sin adjuntos. La certificación corre en paralelo a la cobranza."}
                </p>
                <div>
                  <AttachButton onAttach={() => setPhotoOpen(true)} disabled={isPending} />
                </div>
              </div>
            )}
            {photos.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {photos.map((p) => {
                  const url = (typeof p.photo_url === "string" && p.photo_url) || (typeof p.video_url === "string" && p.video_url) || null;
                  const isVideo = typeof p.video_url === "string" && !!p.video_url;
                  return (
                  <li key={String(p.id)} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <AttributeBadge label={isVideo ? "Video" : "Foto"} title="Tipo de adjunto" />
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="truncate font-medium text-primary underline-offset-4 hover:underline">
                          Ver adjunto
                        </a>
                      ) : (
                        <span className="truncate font-medium">Adjunto</span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDateTime(p.taken_at)}</span>
                      {by(p) && (
                        <span className="shrink-0 truncate text-xs text-muted-foreground" title={`Agregado por ${by(p)}`}>{by(p)}</span>
                      )}
                    </span>
                    {canEdit && (
                      <RowIconButton
                        icon={X}
                        label="Eliminar adjunto"
                        title="Eliminar (por error al adjuntar)"
                        disabled={isPending}
                        pending={isPending}
                        onClick={() => void runFlow("Adjunto eliminado", () => deletePhotoAction({ photoId: String(p.id) }))}
                      />
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
          </AppCard>
            </>
          )}

          {tab === "cobranza" && (
          <>
          <AppCard
            title="Cobranza"
            description="Carril paralelo: admite upfront y abonos a mitad de pauta."
            tone="violet"
            aria-label="Cobranza"
            action={
              <span className="flex items-center gap-2">
                {bill && <OrderBillingBadge status={bill.status} prepaid={bill.isPrepaid} prefixed />}
                {canEdit && (
                  <Button size="xs" variant="outline" onClick={() => setInvOpen(true)} disabled={isPending}>
                    <Receipt aria-hidden />
                    Registrar factura
                  </Button>
                )}
              </span>
            }
          >
            {bill && gross > 0 && (
              <div className="flex flex-col gap-1.5" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Cobrado ${progress}% del bruto`}>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={bill.status === "vencido" ? "h-full rounded-full bg-destructive" : bill.status === "pagado" ? "h-full rounded-full bg-emerald-500" : "h-full rounded-full bg-primary"}
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  <Money amountMinor={bill.paid_minor} currency={orderCurrency} decimals={2} /> cobrado de <Money amountMinor={gross} currency={orderCurrency} /> · {progress}%
                </p>
              </div>
            )}
            {invoices.length === 0 ? (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="text-sm text-muted-foreground">
                  Sin facturas emitidas. Puedes facturar antes, durante o después de la pauta.
                </p>
              </div>
            ) : (
              <>
                <DrawerTable flush>
                  <DrawerTableHeader flush>
                    <DrawerTableTh>Número</DrawerTableTh>
                    <DrawerTableTh>Estado</DrawerTableTh>
                    <DrawerTableTh numeric>Monto</DrawerTableTh>
                    <DrawerTableTh numeric>Cobrado</DrawerTableTh>
                    <DrawerTableTh numeric>Saldo</DrawerTableTh>
                    <DrawerTableTh>Emisión</DrawerTableTh>
                    <DrawerTableTh>Vence</DrawerTableTh>
                    <DrawerTableTh>Acciones</DrawerTableTh>
                  </DrawerTableHeader>
                  <DrawerTableBody>
                    {invoices.map((v) => {
                      const amount = Number(v.amount_minor ?? NaN);
                      const st = String(v.status ?? "");
                      const terminal = st === "cancelled" || st === "draft";
                      const invoiceBill = toBillingInvoice(v);
                      const invoicePaid = invoicePaidMinor(invoiceBill, nowMs);
                      const displayStatus = terminal ? st : aggregateCobranza([invoiceBill], nowMs).overdueMinor > 0
                        ? "overdue" : invoicePaid > 0 && invoicePaid < amount ? "partial" : st;
                      return (
                        <DrawerTableRow key={String(v.id)}>
                          <DrawerTableTd className="font-medium whitespace-nowrap">{str(v.number)}</DrawerTableTd>
                          <DrawerTableTd>
                            <OrderInvoiceBadge status={displayStatus} />
                          </DrawerTableTd>
                          <DrawerTableTd numeric className="tabular-nums whitespace-nowrap">
                            {Number.isFinite(amount) ? <Money amountMinor={amount} currency={typeof v.currency === "string" && v.currency ? v.currency : orderCurrency} decimals={2} /> : "—"}
                          </DrawerTableTd>
                          <DrawerTableTd numeric className="whitespace-nowrap"><Money amountMinor={invoicePaid} currency={String(v.currency)} decimals={2} /></DrawerTableTd>
                          <DrawerTableTd numeric className="whitespace-nowrap">{terminal ? "—" : <Money amountMinor={Math.max(0, amount - invoicePaid)} currency={String(v.currency)} decimals={2} />}</DrawerTableTd>
                          <DrawerTableTd className="text-xs whitespace-nowrap tabular-nums">
                            {typeof v.issue_date === "string" && v.issue_date ? formatDate(v.issue_date) : "—"}
                          </DrawerTableTd>
                          <DrawerTableTd className="text-xs whitespace-nowrap tabular-nums">
                            {typeof v.due_date === "string" && v.due_date ? formatDate(v.due_date) : "—"}
                          </DrawerTableTd>
                          <DrawerTableTd>
                            <span className="flex flex-wrap items-center gap-1">
                              <InvoicePayments invoice={v} currency={String(v.currency)} canEdit={canEditRole} onSaved={() => { void load(); router.refresh(); }} />
                              {!terminal && canEditRole && invoicePaid === 0 && (
                                <Button variant="ghost" size="xs" aria-label={`Anular factura ${str(v.number)}`} title="Anular factura sin cobros" disabled={isPending}
                                  onClick={() => void runFlow("Factura anulada", () => setInvoiceStatusAction({ invoiceId: String(v.id), status: "cancelled" }))}>Anular</Button>
                              )}
                            </span>
                            </DrawerTableTd>
                        </DrawerTableRow>
                      );
                    })}
                  </DrawerTableBody>
                </DrawerTable>
                {bill && (
                  <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                    <div><dt className="text-xs text-muted-foreground">Por facturar</dt><dd className="mt-1 text-sm tabular-nums"><Money amountMinor={bill.unbilled_minor} currency={orderCurrency} decimals={2} /></dd></div>
                    <div><dt className="text-xs text-muted-foreground">Facturado</dt><dd className="mt-1 text-sm tabular-nums"><Money amountMinor={bill.invoiced_minor} currency={orderCurrency} decimals={2} /></dd></div>
                    <div><dt className="text-xs text-muted-foreground">Cobrado</dt><dd className="mt-1 text-sm tabular-nums"><Money amountMinor={bill.paid_minor} currency={orderCurrency} decimals={2} />{bill.isPrepaid ? " · prepago" : ""}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Por cobrar (facturado)</dt><dd className={`mt-1 text-sm tabular-nums ${bill.status === "vencido" ? "font-semibold text-destructive" : ""}`}><Money amountMinor={bill.pending_minor} currency={orderCurrency} decimals={2} /></dd></div>
                  </dl>
                )}
              </>
            )}
          </AppCard>
          </>
          )}
        </>
      )}
      </>
      )}

      <Dialog open={linesOpen} onOpenChange={(v) => !v && setLinesOpen(false)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto p-6 sm:min-w-[720px] max-w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>Editar pantallas</DialogTitle>
            <DialogDescription>
              Solo borradores sin facturas ni reservas. El reemplazo verifica disponibilidad y es atómico.
            </DialogDescription>
          </DialogHeader>
          {screensError ? (
            <div className="flex flex-col gap-3">
              <AppCardState>{screensError}</AppCardState>
              <RetryButton
                onRetry={() => {
                  setScreens(null);
                  setScreensError(null);
                  setScreensLoading(false);
                  void openLinesDialog();
                }}
              />
            </div>
          ) : screens === null || screensLoading ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando pantallas">
              <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
            </div>
          ) : (
            <OrderLinesForm
              key={`${orderId}-${linesNonce}`}
              orderId={orderId}
              orderCurrency={orderCurrency}
              initialLines={lines}
              screens={screens}
              onSaved={() => {
                setLinesOpen(false);
                toast.add({ title: "Pantallas actualizadas", description: "El bruto y el periodo se recalcularon.", type: "success" });
                void load();
              }}
              onCancel={() => setLinesOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={signOpen} onOpenChange={(v) => !v && setSignOpen(false)}>
        <DialogContent className="w-auto max-w-[calc(100%-2rem)] sm:min-w-[420px]">
          <DialogHeader>
            <DialogTitle>Marcar orden como firmada</DialogTitle>
            <DialogDescription>
              Confirma que el cliente firmó la orden. Pasará a etapa Firmada y pedirá el OM/OC.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="flex justify-end gap-2">
              <CancelButton size="sm" onCancel={() => setSignOpen(false)} disabled={isPending} />
              <SubmitButton size="sm" type="button" onClick={doSign} pending={isPending} pendingLabel="Firmando…">
                <PenLine aria-hidden />
                Confirmar firma
              </SubmitButton>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AttachUrlDialog
        open={omOpen}
        onOpenChange={setOmOpen}
        title="Adjuntar autorización"
        description="Pega la URL del documento. La autorización libera Materiales."
        inputId="ord-om-url"
        emptyHint="Pega la URL del documento."
        pending={isPending}
        onConfirm={doCreateOm}
      />

      <AttachUrlDialog
        open={matOpen}
        onOpenChange={setMatOpen}
        title="Adjuntar material"
        description="Pega la URL del material. Nace aprobado."
        inputId="ord-mat-url"
        emptyHint="Pega la URL del material."
        pending={isPending}
        onConfirm={doAttachMat}
      />

      <AttachUrlDialog
        open={photoOpen}
        onOpenChange={setPhotoOpen}
        title="Adjuntar foto check"
        description="Foto o video por URL. Si termina en .mp4/.mov/.webm se guarda como video."
        inputId="ord-photo-url"
        emptyHint="Pega el enlace de la foto o video."
        pending={isPending}
        onConfirm={doAttachPhoto}
      />

      <Dialog open={invOpen} onOpenChange={(v) => !v && setInvOpen(false)}>
        <DialogContent className="p-6 sm:min-w-[480px]">
          <DialogHeader>
            <DialogTitle>Registrar factura</DialogTitle>
            <DialogDescription>
              Comprobante emitido en {orderCurrency}. El vencimiento se sugiere desde la condición de pago.
            </DialogDescription>
          </DialogHeader>
          <InvoiceForm
            key={`${orderId}-${invoices.length}`}
            orderId={orderId}
            orderCurrency={orderCurrency}
            paymentTermsDays={typeof o?.payment_terms_days === "number" ? (o.payment_terms_days as number) : null}
            billingName={detail?.billing_name ?? null}
            billingTaxId={detail?.billing_tax_id ?? null}
            billingCountry={detail?.billing_country ?? null}
            grossMinor={gross}
            invoicedMinor={bill?.invoiced_minor ?? 0}
            taxCountry={detail?.shop_country ?? null}
            onSaved={() => {
              setInvOpen(false);
              toast.add({ title: "Factura registrada", description: "Ya figura en cobranza.", type: "success" });
              void load();
            }}
            onCancel={() => setInvOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={(v) => !v && setCancelOpen(false)}>
        <DialogContent className="w-auto max-w-[calc(100%-2rem)] sm:min-w-[420px]">
          <DialogHeader>
            <DialogTitle>Cancelar orden</DialogTitle>
            <DialogDescription>
              {o ? `Se cancelará ${String(o.io_number ?? "la orden")}. Es terminal: los adjuntos se conservan como evidencia.` : "Es terminal."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <DialogVolverButton onClose={() => setCancelOpen(false)} disabled={isPending} />
            <DangerButton onClick={doCancelOrder} pending={isPending} pendingLabel="Cancelando…">
              <Ban aria-hidden />
              Confirmar cancelación
            </DangerButton>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={reactOpen} onOpenChange={(v) => !v && setReactOpen(false)}>
        <DialogContent className="w-auto max-w-[calc(100%-2rem)] sm:min-w-[420px]">
          <DialogHeader>
            <DialogTitle>Reactivar orden</DialogTitle>
            <DialogDescription>
              {o ? `${String(o.io_number ?? "La orden")} volverá a borrador: podrás firmarla de nuevo.` : "Volverá a borrador."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <DialogVolverButton onClose={() => setReactOpen(false)} disabled={isPending} />
            <SubmitButton size="sm" type="button" onClick={doReactivateOrder} pending={isPending} pendingLabel="Reactivando…">
              <CircleCheckBig aria-hidden />
              Confirmar reactivación
            </SubmitButton>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={delOpen} onOpenChange={(v) => !v && setDelOpen(false)}>
        <DialogContent className="w-auto max-w-[calc(100%-2rem)] sm:min-w-[420px]">
          <DialogHeader>
            <DialogTitle>Eliminar orden</DialogTitle>
            <DialogDescription>
              {o ? `Se eliminará ${String(o.io_number ?? "la orden")} con sus líneas, autorizaciones y adjuntos. Esta acción no se puede deshacer.` : "Esta acción no se puede deshacer."}
              {" Con facturas, reservas, campañas o emisiones vinculadas no se puede eliminar."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <DialogVolverButton onClose={() => setDelOpen(false)} disabled={isPending} />
            <DangerButton onClick={doDeleteOrder} pending={isPending} pendingLabel="Eliminando…">
              <Trash aria-hidden />
              Confirmar eliminación
            </DangerButton>
          </div>
        </DialogContent>
      </Dialog>
    </DrawerShell>
  );
}
