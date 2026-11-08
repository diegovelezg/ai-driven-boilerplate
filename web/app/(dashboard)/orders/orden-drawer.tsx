"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, CircleArrowLeft, FileText, Package, Pencil, Plus, Receipt, X } from "lucide-react";
import { AppCard, AppCardState } from "@/components/app-card";
import { DrawerShell, type DrawerTabDef } from "@/components/drawer-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OrderApprovalBadge, OrderAutorizadaBadge, OrderBillingBadge, OrderInvoiceBadge, OrderStageBadge, orderStageDisplay } from "@/components/order-badges";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { Steps } from "@/components/steps";
import { SectionHeading } from "@/components/section-heading";
import { DrawerTable, DrawerTableBody, DrawerTableHeader, DrawerTableRow, DrawerTableTd, DrawerTableTh } from "@/components/drawer-table";
import { ORDER_STEPS, orderStage } from "@/lib/order-stage";
import { BILLING_LABELS, billingStatus } from "@/lib/billing-status";
import { createAgencyOrderAction, signOrderAction, deleteAgencyOrderAction, attachCreativeAction, deleteCreativeAction, attachPhotoAction, deletePhotoAction, cancelOrderAction } from "@/lib/order-flow-actions";
import { OrdenChat } from "./orden-chat";
import { OrderEditForm } from "./order-edit-form";
import { hasMinRole, isMemberRole, type MemberRole } from "@/lib/roles";
import { formatMoney, formatNumber, paymentTermsLabel, toTitleCase } from "@/lib/format";

interface Detail {
  order: Record<string, unknown>;
  advertiser_name: string | null;
  billing_name: string | null;
  billing_kind: string | null;
  lines: Array<Record<string, unknown>>;
  io_agency_orders: Array<Record<string, unknown>>;
  creatives: Array<Record<string, unknown>>;
  bookings_count: number;
  photos: Array<Record<string, unknown>>;
  photos_count: number;
  invoices: Array<Record<string, unknown>>;
}

/** "2026-11-03" o ISO "2026-11-03T00:00:00-05:00" → "03/11/2026". */
function fmtFecha(v: unknown): string {
  if (typeof v !== "string" || !v) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

/** Timestamptz → "03/11/2026 14:05" en Lima. Fecha sola → solo fecha. */
function fmtFechaHora(v: unknown): string {
  if (typeof v !== "string" || !v) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtFecha(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return fmtFecha(v);
  try {
    const f = new Intl.DateTimeFormat("es-PE", {
      timeZone: "America/Lima",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return f.format(new Date(t)).replace(",", "");
  } catch {
    return fmtFecha(v);
  }
}

/** Fin exclusivo de línea (BD, '[)') → día inclusivo "yyyy-mm-dd". */
function inclusiveEndOf(exclusiveIso: unknown): string | null {
  if (typeof exclusiveIso !== "string" || !exclusiveIso) return null;
  const t = Date.parse(exclusiveIso);
  if (Number.isNaN(t)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(exclusiveIso);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  const d = new Date(t - 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function diffDias(inicio: unknown, finInclusivo: unknown): number | null {
  const a = typeof inicio === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(inicio) : null;
  const b = typeof finInclusivo === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(finInclusivo) : null;
  if (!a || !b) return null;
  const da = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const db = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  const n = Math.round((db - da) / 86_400_000) + 1;
  return n >= 1 ? n : null;
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

export function OrdenDrawer({ orderId, myRole, onClose }: { orderId: string; myRole: MemberRole | null; onClose: () => void }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"resumen" | "produccion" | "cobranza" | "agentes">("resumen");
  const [editingFicha, setEditingFicha] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [signOpen, setSignOpen] = useState(false);
  const [omOpen, setOmOpen] = useState(false);
  const [omUrl, setOmUrl] = useState("");
  const [matOpen, setMatOpen] = useState(false);
  const [matUrl, setMatUrl] = useState("");
  const [matDur, setMatDur] = useState("");
  const [matW, setMatW] = useState("");
  const [matH, setMatH] = useState("");
  const [photoOpen, setPhotoOpen] = useState(false);
  const [photoUrl, setPhotoUrl] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("No se pudo cargar la orden.");
      setDetail((await res.json()) as Detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "DB read failed");
    }
  }, [orderId]);

  useEffect(() => {
    setTab("resumen");
    setDetail(null);
    setEditingFicha(false);
    void load();
  }, [load]);

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

  const doCreateOm = () => {
    if (!omUrl.trim()) {
      toast.add({ title: "Falta la URL", description: "Pega la URL del documento.", type: "error" });
      return;
    }
    startTransition(async () => {
      const res = await createAgencyOrderAction({ orderId, documentUrl: omUrl.trim() });
      if (res.ok) {
        toast.add({ title: "OM registrada", description: res.message, type: "success" });
        setOmOpen(false);
        setOmUrl("");
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

  const openMatDialog = () => {
    setMatUrl("");
    setMatDur("");
    setMatW("");
    setMatH("");
    setMatOpen(true);
  };

  const doAttachMat = () => {
    if (!matUrl.trim()) {
      toast.add({ title: "Falta la URL", description: "Pega la URL del material.", type: "error" });
      return;
    }
    startTransition(async () => {
      const res = await attachCreativeAction({
        orderId,
        fileUrl: matUrl.trim(),
        durationSec: matDur.trim() || null,
        widthPx: matW.trim() || null,
        heightPx: matH.trim() || null,
      });
      if (res.ok) {
        toast.add({ title: "Material adjuntado", description: res.message, type: "success" });
        setMatOpen(false);
        setMatUrl("");
        setMatDur("");
        setMatW("");
        setMatH("");
        await load();
      } else {
        toast.add({ title: "No se pudo adjuntar", description: res.message, type: "error" });
      }
    });
  };

  const doAttachPhoto = () => {
    if (!photoUrl.trim()) {
      toast.add({ title: "Falta la URL", description: "Pega el enlace de la foto o video.", type: "error" });
      return;
    }
    startTransition(async () => {
      const res = await attachPhotoAction({ orderId, url: photoUrl.trim() });
      if (res.ok) {
        toast.add({ title: "Adjunto guardado", description: res.message, type: "success" });
        setPhotoOpen(false);
        setPhotoUrl("");
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

  const o = detail?.order;
  const orderCurrency = String((o as Record<string, unknown> | undefined)?.currency ?? "PEN").toUpperCase() || "PEN";
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
        ended: o.ends_at ? Date.parse(String(o.ends_at)) <= Date.now() : false,
        certified: (detail?.photos_count ?? 0) > 0,
      })
    : null;
  const bill = o
    ? billingStatus({
        gross_minor: gross,
        invoices: invoices.map((v) => ({
          amount_minor: Number(v.amount_minor ?? 0),
          status: String(v.status ?? ""),
          issue_date: (v.issue_date as string | null) ?? null,
          due_date: (v.due_date as string | null) ?? null,
        })),
        starts_at: (o.starts_at as string | null) ?? null,
        payment_terms_days:
          typeof o.payment_terms_days === "number" ? (o.payment_terms_days as number) : null,
      })
    : null;

  const diasOi = o ? diffDias(str(o.starts_at) === "—" ? null : o.starts_at, str(o.ends_at) === "—" ? null : o.ends_at) : null;
  const brand = typeof o?.brand === "string" && o.brand ? o.brand : null;
  const contratante = detail?.billing_name ?? null;
  const contratanteKind = detail?.billing_kind === "agencia" ? "Agencia" : detail?.billing_kind === "anunciante" ? "Anunciante" : null;
  const ended = o?.ends_at ? Date.parse(String(o.ends_at)) <= Date.now() : false;
  const nextAction: string | null = !st
    ? null
    : st.stage === "cancelada"
      ? "Orden cancelada: sin acciones pendientes."
      : st.index === 0
        ? "Borrador: falta la firma del cliente para avanzar."
        : st.index === 1
          ? "Firmada: adjunta la autorización para pasar a Materiales."
          : st.stage === "materiales"
            ? "En Materiales: falta aprobar QC + legal de todas las piezas."
            : st.stage === "al_aire"
              ? `En emisión${o?.ends_at ? ` hasta el ${fmtFecha(o.ends_at)}` : ""}: el cobro corre en paralelo.`
              : st.stage === "por_certificar"
                ? "Terminó la pauta: sube el foto check / PoP para cerrar."
                : "Ciclo operativo completo. Revisa que el cobro esté en Pagado.";
  const progress = bill && gross > 0 ? Math.min(100, Math.round((bill.paid_minor / gross) * 100)) : 0;
  const isDraft = String(o?.status ?? "") === "draft";
  const isCancelled = String(o?.status ?? "") === "cancelled";
  // Sin auth (dev: myRole null) se permite editar; viewer = solo lectura.
  const canEditRole = myRole === null || (isMemberRole(myRole) && hasMinRole(myRole, "seller"));
  const canEdit = canEditRole && !isCancelled;
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
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void load()}>
            Reintentar
          </Button>
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
            <section aria-label="Firmar orden" className="flex flex-col gap-2 rounded-xl border border-dashed px-4 py-3">
              <p className="text-[13px] font-medium">Borrador: esperando la firma del cliente</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Cuando el cliente firme la OI, márcala aquí. Recién entonces podrás registrar el OM/OC.
              </p>
              <div>
                <Button size="sm" onClick={() => setSignOpen(true)} disabled={isPending}>
                  Marcar firmada
                </Button>
              </div>
            </section>
          )}
          <AppCard
            title="Ficha"
            description="Mismos datos de Nueva orden: contratante, marca, periodo y pago."
            aria-label="Ficha de la orden"
            action={
              canEdit && !editingFicha ? (
                <Button variant="outline" size="sm" onClick={() => setEditingFicha(true)}>
                  <Pencil className="size-3.5" aria-hidden /> Editar
                </Button>
              ) : undefined
            }
          >
            {editingFicha ? (
              <OrderEditForm
                key={orderId}
                orderId={orderId}
                initial={{
                  brand: typeof o.brand === "string" ? o.brand : "",
                  payment_terms_days: typeof o.payment_terms_days === "number" ? String(o.payment_terms_days) : "",
                  notes: typeof o.notes === "string" ? o.notes : "",
                }}
                onSaved={() => {
                  setEditingFicha(false);
                  router.refresh();
                  void load();
                }}
                onCancel={() => setEditingFicha(false)}
              />
            ) : (
            <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Contratante</dt><dd className="mt-0.5 text-[13px] font-medium">{contratante ? `${toTitleCase(contratante)}${contratanteKind ? ` · ${contratanteKind}` : ""}` : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Marca</dt><dd className="mt-0.5 text-[13px]">{brand ? toTitleCase(brand) : "—"}</dd></div>
              <div>
                <dt className="text-xs text-muted-foreground">Periodo</dt>
                <dd className="mt-0.5 text-[13px] tabular-nums">
                  {o.starts_at && o.ends_at
                    ? `${fmtFecha(o.starts_at)} → ${fmtFecha(o.ends_at)}${diasOi ? ` · ${formatNumber(diasOi)} días` : ""}`
                    : "—"}
                </dd>
              </div>
              <div><dt className="text-xs text-muted-foreground">Bruto</dt><dd className="mt-0.5 text-[13px] font-semibold tabular-nums">{gross > 0 ? formatMoney(gross, orderCurrency) : "—"} <span className="text-[11px] font-normal text-muted-foreground">{orderCurrency}</span></dd></div>
              <div><dt className="text-xs text-muted-foreground">Condición de pago</dt><dd className="mt-0.5 text-[13px]">{typeof o.payment_terms_days === "number" ? paymentTermsLabel(o.payment_terms_days) : str(o.payment_terms)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Estado</dt><dd className="mt-0.5 text-[13px]">{STATUS_LABEL[String(o.status ?? "")] ?? str(o.status)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Firma</dt><dd className="mt-0.5 text-[13px] tabular-nums">{o.signed_at ? fmtFechaHora(o.signed_at) : "—"}</dd></div>
              <div>
                <dt className="text-xs text-muted-foreground">Creada</dt>
                <dd className="mt-0.5 text-[13px] tabular-nums">{o.created_at ? fmtFechaHora(o.created_at) : "—"}{o.created_by ? ` · ${str(o.created_by)}` : ""}</dd>
              </div>
              {typeof o.updated_at === "string" && o.updated_at && o.updated_at !== o.created_at && (
                <div>
                  <dt className="text-xs text-muted-foreground">Actualizada</dt>
                  <dd className="mt-0.5 text-[13px] tabular-nums">{fmtFechaHora(o.updated_at)}{typeof o.updated_by === "string" && o.updated_by ? ` · ${o.updated_by}` : ""}</dd>
                </div>
              )}
            </dl>
            )}
          </AppCard>

          {lines.length === 0 ? (
            <div className="rounded-lg border border-dashed px-3 py-3">
              <p className="text-[13px] text-muted-foreground">Sin líneas.</p>
            </div>
          ) : (
              <DrawerTable>
                <DrawerTableHeader>
                  <DrawerTableTh>Pantalla</DrawerTableTh>
                  <DrawerTableTh>Periodo</DrawerTableTh>
                  <DrawerTableTh numeric>Días</DrawerTableTh>
                  <DrawerTableTh numeric>Total</DrawerTableTh>
                </DrawerTableHeader>
                <DrawerTableBody>
                  {lines.map((l) => {
                    const finIncl = inclusiveEndOf(l.ends_at);
                    const dias = typeof l.cant_dias === "number" && l.cant_dias > 0
                      ? l.cant_dias
                      : diffDias(typeof l.starts_at === "string" ? l.starts_at : null, finIncl);
                    const regular = Number(l.tarifa_regular_minor ?? NaN);
                    return (
                      <DrawerTableRow key={String(l.id)}>
                        <DrawerTableTd className="font-medium">
                          {str(l.screen_name)}
                          {typeof l.screen_detail === "string" && l.screen_detail && (
                            <span className="block max-w-[280px] truncate text-[11px] font-normal text-muted-foreground">{l.screen_detail}</span>
                          )}
                          {typeof l.notes === "string" && l.notes && (
                            <span className="block text-[11px] font-normal text-muted-foreground">{l.notes}</span>
                          )}
                          {Number.isFinite(regular) && regular > 0 && regular !== Number(l.rate_minor ?? 0) && (
                            <span className="block text-[11px] font-normal text-muted-foreground tabular-nums">
                              Reg. {formatMoney(regular, orderCurrency)}
                            </span>
                          )}
                        </DrawerTableTd>
                        <DrawerTableTd className="text-xs tabular-nums">
                          {fmtFecha(l.starts_at)} → {finIncl ? fmtFecha(finIncl) : "—"}
                        </DrawerTableTd>
                        <DrawerTableTd numeric className="text-xs tabular-nums">
                          {dias ?? "—"}
                        </DrawerTableTd>
                        <DrawerTableTd numeric className="tabular-nums">
                          {formatMoney(l.rate_minor as number, orderCurrency)}
                        </DrawerTableTd>
                      </DrawerTableRow>
                    );
                  })}
                  <DrawerTableRow className="bg-muted/30 font-medium">
                    <DrawerTableTd colSpan={3}>
                      Total · {formatNumber(lines.length)} pantalla{lines.length === 1 ? "" : "s"}
                    </DrawerTableTd>
                    <DrawerTableTd numeric className="tabular-nums">
                      {gross > 0 ? formatMoney(gross, orderCurrency) : "—"}
                    </DrawerTableTd>
                  </DrawerTableRow>
                </DrawerTableBody>
              </DrawerTable>
            )}
          {typeof o.notes === "string" && o.notes && (
              <p className="text-xs leading-relaxed text-muted-foreground">{o.notes}</p>
            )}
            {canEdit && !isDraft && (
              <div>
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setCancelOpen(true)} disabled={isPending}>
                  Cancelar orden
                </Button>
              </div>
            )}
            </>
          )}

          {tab === "produccion" && (
          <>
          <AppCard
            title={`Autorización (${oms.length})`}
            description="OM de la agencia. Sin autorización la orden no avanza a Materiales."
            action={
              canEdit && !isDraft && oms.length > 0 ? (
                <Button variant="outline" size="sm" onClick={() => { setOmUrl(""); setOmOpen(true); }} disabled={isPending}>
                  <Plus className="size-3.5" aria-hidden /> Adjuntar
                </Button>
              ) : undefined
            }
            tone="sky"
            aria-label="Autorización"
          >
            {oms.length === 0 ? (
              <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3">
                <p className="text-[13px] text-muted-foreground">
                  {isDraft
                    ? "Primero marca la orden como firmada; luego adjunta la autorización."
                    : "Sin OM/OC registrado. La autorización es el hito que libera Materiales."}
                </p>
                {canEdit && !isDraft && (
                  <div>
                    <Button size="sm" onClick={() => { setOmUrl(""); setOmOpen(true); }} disabled={isPending}>
                      <Plus className="size-3.5" aria-hidden /> Adjuntar
                    </Button>
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
                  <li key={String(m.id)} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2 text-[13px]">
                      <Badge variant="secondary" className="font-normal">{str(m.kind)}</Badge>
                      {!codeIsUrl && <span className="truncate font-medium">{rawCode}</span>}
                      {href && (
                        <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-primary underline-offset-4 hover:underline">
                          Adjunto
                        </a>
                      )}
                      {by(m) && (
                        <span className="shrink-0 truncate text-[11px] text-muted-foreground" title={`Agregado por ${by(m)}`}>{by(m)}</span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Eliminar ${str(m.kind)} ${rawCode}`}
                          title="Eliminar (por error al registrar)"
                          onClick={() => void runFlow("OM eliminado", () => deleteAgencyOrderAction({ agencyOrderId: String(m.id) }))}
                          disabled={isPending}
                        >
                          <X className="size-3.5" aria-hidden />
                        </Button>
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
            description="Adjunta la pieza; nace aprobada y libera la emisión."
            action={
              canEdit && creatives.length > 0 ? (
                <Button variant="outline" size="sm" onClick={openMatDialog} disabled={isPending}>
                  <Plus className="size-3.5" aria-hidden /> Adjuntar
                </Button>
              ) : undefined
            }
            tone="violet"
            aria-label="Materiales"
          >
            {creatives.length === 0 ? (
              <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3">
                <p className="text-[13px] text-muted-foreground">
                  Sin piezas cargadas. Adjunta el material para pasar a emisión.
                </p>
                {canEdit && (
                  <div>
                    <Button size="sm" onClick={openMatDialog} disabled={isPending}>
                      <Plus className="size-3.5" aria-hidden /> Adjuntar
                    </Button>
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
                  <li key={String(c.id)} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <span className="min-w-0 truncate text-[13px] font-medium">
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
                        <span className="hidden truncate text-[11px] text-muted-foreground md:block" title={`Agregado por ${by(c)}`}>{by(c)}</span>
                      )}
                      <OrderApprovalBadge approved={ok} />
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Eliminar ${str(c.name)}`}
                          title="Eliminar (por error al adjuntar)"
                          onClick={() => void runFlow("Material eliminado", () => deleteCreativeAction({ creativeId: String(c.id) }))}
                          disabled={isPending}
                        >
                          <X className="size-3.5" aria-hidden />
                        </Button>
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
            description="Foto check + PoP. Corre en paralelo a la cobranza."
            action={
              canEdit && photos.length > 0 ? (
                <Button variant="outline" size="sm" onClick={() => { setPhotoUrl(""); setPhotoOpen(true); }} disabled={isPending}>
                  <Plus className="size-3.5" aria-hidden /> Adjuntar
                </Button>
              ) : undefined
            }
            tone="emerald"
            aria-label="Certificación"
          >
            {photos.length === 0 && canEdit && (
              <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3">
                <p className="text-[13px] text-muted-foreground">
                  {ended
                    ? "La pauta terminó sin foto check: adjúntalo para cerrar el ciclo operativo."
                    : "Sin adjuntos. La certificación corre en paralelo a la cobranza."}
                </p>
                <div>
                  <Button size="sm" onClick={() => { setPhotoUrl(""); setPhotoOpen(true); }} disabled={isPending}>
                    <Plus className="size-3.5" aria-hidden /> Adjuntar
                  </Button>
                </div>
              </div>
            )}
            {photos.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {photos.map((p) => {
                  const url = (typeof p.photo_url === "string" && p.photo_url) || (typeof p.video_url === "string" && p.video_url) || null;
                  const isVideo = typeof p.video_url === "string" && !!p.video_url;
                  return (
                  <li key={String(p.id)} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2 text-[13px]">
                      <Badge variant="secondary" className="font-normal">{isVideo ? "Video" : "Foto"}</Badge>
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="truncate font-medium text-primary underline-offset-4 hover:underline">
                          Ver adjunto
                        </a>
                      ) : (
                        <span className="truncate font-medium">Adjunto</span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtFechaHora(p.taken_at)}</span>
                      {by(p) && (
                        <span className="shrink-0 truncate text-[11px] text-muted-foreground" title={`Agregado por ${by(p)}`}>{by(p)}</span>
                      )}
                    </span>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Eliminar adjunto"
                        title="Eliminar (por error al adjuntar)"
                        onClick={() => void runFlow("Adjunto eliminado", () => deletePhotoAction({ photoId: String(p.id) }))}
                        disabled={isPending}
                      >
                        <X className="size-3.5" aria-hidden />
                      </Button>
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
          <section className="flex flex-col gap-2" aria-label="Cobranza">
            <SectionHeading
              title="Cobranza"
              hint="Carril paralelo: admite upfront y abonos a mitad de pauta."
              right={bill && <OrderBillingBadge status={bill.status} prepaid={bill.isPrepaid} prefixed />}
            />
            {bill && gross > 0 && (
              <div className="flex flex-col gap-1.5" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Cobrado ${progress}% del bruto`}>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={bill.status === "vencido" ? "h-full rounded-full bg-destructive" : bill.status === "pagado" ? "h-full rounded-full bg-emerald-500" : "h-full rounded-full bg-primary"}
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {formatMoney(bill.paid_minor, orderCurrency)} cobrado de {formatMoney(gross, orderCurrency)} · {progress}%
                </p>
              </div>
            )}
            {invoices.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-3 text-[13px] text-muted-foreground">
                Sin facturas emitidas. Puedes facturar antes, durante o después de la pauta.
              </p>
            ) : (
              <>
                <DrawerTable>
                  <DrawerTableHeader>
                    <DrawerTableTh>Número</DrawerTableTh>
                    <DrawerTableTh>Estado</DrawerTableTh>
                    <DrawerTableTh numeric>Monto</DrawerTableTh>
                    <DrawerTableTh>Vence</DrawerTableTh>
                  </DrawerTableHeader>
                  <DrawerTableBody>
                    {invoices.map((v) => {
                      const amount = Number(v.amount_minor ?? NaN);
                      return (
                        <DrawerTableRow key={String(v.id)}>
                          <DrawerTableTd className="font-medium">{str(v.number)}</DrawerTableTd>
                          <DrawerTableTd>
                            <OrderInvoiceBadge status={String(v.status ?? "")} />
                          </DrawerTableTd>
                          <DrawerTableTd numeric className="tabular-nums">
                            {Number.isFinite(amount) ? formatMoney(amount, typeof v.currency === "string" && v.currency ? v.currency : orderCurrency) : "—"}
                          </DrawerTableTd>
                          <DrawerTableTd className="text-xs whitespace-nowrap tabular-nums">
                            {typeof v.due_date === "string" && v.due_date ? fmtFecha(v.due_date) : "—"}
                          </DrawerTableTd>
                        </DrawerTableRow>
                      );
                    })}
                  </DrawerTableBody>
                </DrawerTable>
                {bill && (
                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                    <div><dt className="text-xs text-muted-foreground">Facturado</dt><dd className="mt-0.5 text-[13px] tabular-nums">{formatMoney(bill.invoiced_minor, orderCurrency)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Cobrado</dt><dd className="mt-0.5 text-[13px] tabular-nums">{formatMoney(bill.paid_minor, orderCurrency)}{bill.isPrepaid ? " · prepago" : ""}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Pendiente</dt><dd className={`mt-0.5 text-[13px] tabular-nums ${bill.status === "vencido" ? "font-semibold text-destructive" : ""}`}>{formatMoney(bill.pending_minor, orderCurrency)}</dd></div>
                  </dl>
                )}
              </>
            )}
          </section>
            </>
          )}
        </>
      )}
      </>
      )}

      <Dialog open={signOpen} onOpenChange={(v) => !v && setSignOpen(false)}>
        <DialogContent className="w-auto max-w-[calc(100%-2rem)] sm:min-w-[420px]">
          <DialogHeader>
            <DialogTitle>Marcar orden como firmada</DialogTitle>
            <DialogDescription>
              Confirma que el cliente firmó la OI. Pasará a etapa Firmada y pedirá el OM/OC.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setSignOpen(false)} disabled={isPending}>
                Cancelar
              </Button>
              <Button size="sm" onClick={doSign} disabled={isPending}>
                {isPending ? "Firmando…" : "Confirmar firma"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={omOpen} onOpenChange={(v) => !v && setOmOpen(false)}>
        <DialogContent className="w-auto max-w-[calc(100%-2rem)] sm:min-w-[420px]">
          <DialogHeader>
            <DialogTitle>Adjuntar autorización</DialogTitle>
            <DialogDescription>
              Pega la URL del documento. La autorización libera Materiales.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ord-om-url">Adjunto (URL) *</Label>
              <Input
                id="ord-om-url"
                value={omUrl}
                onChange={(e) => setOmUrl(e.target.value)}
                placeholder="https://…"
                inputMode="url"
                disabled={isPending}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setOmOpen(false)} disabled={isPending}>
                Cancelar
              </Button>
              <Button size="sm" onClick={doCreateOm} disabled={isPending || !omUrl.trim()}>
                {isPending ? "Adjuntando…" : "Adjuntar"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={matOpen} onOpenChange={(v) => !v && setMatOpen(false)}>
        <DialogContent className="w-auto max-w-[calc(100%-2rem)] sm:min-w-[420px]">
          <DialogHeader>
            <DialogTitle>Adjuntar material</DialogTitle>
            <DialogDescription>
              La pieza nace pendiente; al aprobarla pasa a emisión.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ord-mat-url">Adjunto (URL) *</Label>
              <Input
                id="ord-mat-url"
                value={matUrl}
                onChange={(e) => setMatUrl(e.target.value)}
                placeholder="https://…"
                inputMode="url"
                disabled={isPending}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ord-mat-dur">Duración (s)</Label>
                <Input
                  id="ord-mat-dur"
                  value={matDur}
                  onChange={(e) => setMatDur(e.target.value.replace(/[^0-9.]/g, "").slice(0, 7))}
                  placeholder="10"
                  inputMode="decimal"
                  disabled={isPending}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ord-mat-w">Ancho (px)</Label>
                <Input
                  id="ord-mat-w"
                  value={matW}
                  onChange={(e) => setMatW(e.target.value.replace(/\D/g, "").slice(0, 5))}
                  placeholder="1920"
                  inputMode="numeric"
                  disabled={isPending}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ord-mat-h">Alto (px)</Label>
                <Input
                  id="ord-mat-h"
                  value={matH}
                  onChange={(e) => setMatH(e.target.value.replace(/\D/g, "").slice(0, 5))}
                  placeholder="1080"
                  inputMode="numeric"
                  disabled={isPending}
                />
              </div>
            </div>
            <p className="-mt-1 text-[11px] text-muted-foreground">
              Tamaño de la pieza (opcional): resolución del video/imagen y duración del spot.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setMatOpen(false)} disabled={isPending}>
                Cancelar
              </Button>
              <Button size="sm" onClick={doAttachMat} disabled={isPending || !matUrl.trim()}>
                {isPending ? "Adjuntando…" : "Adjuntar"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={photoOpen} onOpenChange={(v) => !v && setPhotoOpen(false)}>
        <DialogContent className="w-auto max-w-[calc(100%-2rem)] sm:min-w-[420px]">
          <DialogHeader>
            <DialogTitle>Adjuntar foto check</DialogTitle>
            <DialogDescription>
              Foto o video por URL. Si termina en .mp4/.mov/.webm se guarda como video.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ord-photo-url">Adjunto (URL) *</Label>
              <Input
                id="ord-photo-url"
                value={photoUrl}
                onChange={(e) => setPhotoUrl(e.target.value)}
                placeholder="https://…"
                inputMode="url"
                disabled={isPending}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPhotoOpen(false)} disabled={isPending}>
                Cancelar
              </Button>
              <Button size="sm" onClick={doAttachPhoto} disabled={isPending || !photoUrl.trim()}>
                {isPending ? "Adjuntando…" : "Adjuntar"}
              </Button>
            </div>
          </div>
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
            <Button variant="outline" size="sm" onClick={() => setCancelOpen(false)} disabled={isPending}>
              <CircleArrowLeft />Volver
            </Button>
            <Button variant="destructive" size="sm" onClick={doCancelOrder} disabled={isPending}>
              {isPending ? "Cancelando…" : "Confirmar cancelación"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DrawerShell>
  );
}
