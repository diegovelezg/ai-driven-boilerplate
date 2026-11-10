import { Badge } from "@/components/ui/badge";
import {
  attributeDisplay,
  campaignBadgeDisplay,
  companyIoBadgeDisplay,
  ioEmptyBadgeDisplay,
  principalBadgeDisplay,
} from "@/lib/ui-badges";
import { kindLabel } from "@/lib/crm";
import { OrderStageBadge } from "@/components/order-badges";

/**
 * SSOT de insignias de empresas (componentes finos).
 * Gramática en `lib/ui-badges.tsx`. Los estados de IO reutilizan
 * el semáforo de órdenes (`OrderStageBadge`).
 */

/** Tipo de contraparte: identidad neutra (borde), no estado. */
export function CompanyKindBadge({ kind }: { kind: string | null }) {
  const d = attributeDisplay(kindLabel(kind), "Tipo de contraparte");
  return (
    <Badge variant={d.variant} className="font-normal" title={d.title}>
      {d.label}
    </Badge>
  );
}

/** Estado de una IO (draft/signed/cancelled) con la gramática de órdenes.
 *  SSOT en lib/ui-badges: ''/null = sin dato (—), nunca "Borrador" inventado. */
export function CompanyIOBadge({ status }: { status: string | null | undefined }) {
  const d = companyIoBadgeDisplay(status);
  if (d.isEmpty) {
    const e = ioEmptyBadgeDisplay();
    return (
      <Badge variant={e.variant} className="font-normal" title={e.title}>
        {e.label}
      </Badge>
    );
  }
  if (d.stage === "cancelada") return <OrderStageBadge stage="cancelada" isDraft={false} />;
  if (!d.isDraft) return <OrderStageBadge stage="firmada" isDraft={false} />;
  return <OrderStageBadge stage="firmada" isDraft />;
}

/** Estado de campaña (SSOT en lib/ui-badges, sin ramas locales). */
export function CompanyCampaignBadge({ status }: { status: string | null | undefined }) {
  const d = campaignBadgeDisplay(status);
  return (
    <Badge variant={d.variant} className="font-normal" title={d.title}>
      {d.label}
    </Badge>
  );
}

/** Contacto principal: designación azul, no éxito. */
export function CompanyPrincipalBadge({ isPrimary }: { isPrimary: boolean }) {
  if (!isPrimary) return <span className="text-xs text-muted-foreground">—</span>;
  const d = principalBadgeDisplay();
  return (
    <Badge variant={d.variant} className="font-normal" title={d.title}>
      {d.label}
    </Badge>
  );
}
