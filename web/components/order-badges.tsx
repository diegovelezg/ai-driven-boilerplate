import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ORDER_STAGE_LABELS, type OrderStageKey } from "@/lib/order-stage";
import { BILLING_LABELS, type BillingStatusKey } from "@/lib/billing-status";

/**
 * SSOT de insignias de órdenes: etapa operativa + cobro en paralelo.
 * Un solo lugar para el semáforo; lista y drawer solo componen.
 *
 * Etapa: gris (borrador) → verde (firmada, logro) → outline (requiere
 * acción: materiales, por certificar) → primary (al aire, protagonista) →
 * verde (cerrada) / rojo (cancelada).
 * Cobro (progreso): gris (sin facturar) → outline (facturado) →
 * primary (parcial) → verde (pagado) / rojo (vencido manda).
 */

type BadgeVariant = "default" | "secondary" | "success" | "destructive" | "outline";

export function orderStageDisplay(stage: OrderStageKey, isDraft: boolean): {
  variant: BadgeVariant;
  label: string;
  title: string;
} {
  if (stage === "cancelada") return { variant: "destructive", label: "Cancelada", title: "Orden cancelada" };
  if (stage === "cerrada") return { variant: "success", label: "Cerrada", title: "Ciclo operativo completo" };
  if (stage === "firmada") {
    return isDraft
      ? { variant: "secondary", label: "Borrador", title: "Borrador: aún no la firma el cliente" }
      : { variant: "success", label: "Firmada", title: "Firmada por el cliente" };
  }
  if (stage === "al_aire") return { variant: "default", label: "Al aire", title: "Etapa operativa: en emisión" };
  return { variant: "outline", label: ORDER_STAGE_LABELS[stage], title: "Etapa operativa: requiere acción" };
}

export function OrderStageBadge({ stage, isDraft }: { stage: OrderStageKey; isDraft: boolean }) {
  const d = orderStageDisplay(stage, isDraft);
  return (
    <Badge variant={d.variant} className="font-normal" title={d.title}>
      {d.label}
    </Badge>
  );
}

/** Hito Autorizada: OM registrado. Verde con ✓, siempre explícito. */
export function OrderAutorizadaBadge() {
  return (
    <Badge variant="success" className="font-normal" title="Hito: OM registrado, la orden está autorizada">
      <Check className="size-2.5" aria-hidden /> Autorizada
    </Badge>
  );
}

export function orderBillingDisplay(status: BillingStatusKey): {
  variant: BadgeVariant;
  label: string;
} {
  if (status === "pagado") return { variant: "success", label: BILLING_LABELS[status] };
  if (status === "vencido") return { variant: "destructive", label: BILLING_LABELS[status] };
  if (status === "parcial") return { variant: "default", label: BILLING_LABELS[status] };
  if (status === "facturado") return { variant: "outline", label: BILLING_LABELS[status] };
  return { variant: "secondary", label: BILLING_LABELS[status] };
}

export function OrderBillingBadge({
  status,
  prepaid = false,
  prefixed = false,
}: {
  status: BillingStatusKey;
  prepaid?: boolean;
  /** "Cobro: X" (header) vs "X" (tabla). */
  prefixed?: boolean;
}) {
  const d = orderBillingDisplay(status);
  return (
    <Badge
      variant={d.variant}
      className="font-normal"
      title="Estado de cobro (carril paralelo: admite upfront y abonos)"
    >
      {prefixed ? `Cobro: ${d.label}` : d.label}
      {prepaid ? " · prepago" : ""}
    </Badge>
  );
}

/** Estado de factura individual: misma gramática que el cobro. */
export function OrderInvoiceBadge({ status }: { status: string }) {
  const variant: BadgeVariant =
    status === "paid" ? "success" : status === "overdue" || status === "cancelled" ? "destructive" : status === "issued" ? "outline" : "secondary";
  return (
    <Badge variant={variant} className="font-normal">
      {status || "—"}
    </Badge>
  );
}

/** Aprobación de material: verde o gris, sin estados intermedios. */
export function OrderApprovalBadge({ approved }: { approved: boolean }) {
  return (
    <Badge variant={approved ? "success" : "secondary"} className="font-normal" title="Aprobado al adjuntar">
      {approved ? "Aprobado" : "Pendiente"}
    </Badge>
  );
}
