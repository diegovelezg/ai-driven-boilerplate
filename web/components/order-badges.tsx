import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  approvalBadgeDisplay,
  autorizadaBadgeDisplay,
  invoiceBadgeDisplay,
  orderBillingDisplay,
  orderStageDisplay,
} from "@/lib/ui-badges";
import type { BillingStatusKey } from "@/lib/billing-status";
import type { OrderStageKey } from "@/lib/order-stage";

/**
 * SSOT de insignias de órdenes (componentes finos: sin lógica de color).
 * La gramática vive en `lib/ui-badges.tsx`; aquí solo se compone.
 */

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
  const d = autorizadaBadgeDisplay();
  return (
    <Badge variant={d.variant} className="font-normal" title={d.title}>
      <Check className="size-2.5" aria-hidden /> {d.label}
    </Badge>
  );
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

/** Estado de factura individual: misma gramática que el cobro (SSOT en lib/ui-badges). */
export function OrderInvoiceBadge({ status }: { status: string }) {
  const d = invoiceBadgeDisplay(status);
  return (
    <Badge variant={d.variant} className="font-normal" title="Estado de la factura">
      {d.label}
    </Badge>
  );
}

/** Aprobación de material: verde o ámbar (SSOT), sin grises. */
export function OrderApprovalBadge({ approved }: { approved: boolean }) {
  const d = approvalBadgeDisplay(approved);
  return (
    <Badge variant={d.variant} className="font-normal" title={d.title}>
      {d.label}
    </Badge>
  );
}
