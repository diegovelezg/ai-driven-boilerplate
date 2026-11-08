import { Badge } from "@/components/ui/badge";
import { campaignBadgeDisplay, companyIoBadgeDisplay } from "@/lib/ui-badges";
import { kindLabel } from "@/lib/crm";
import { OrderStageBadge } from "@/components/order-badges";

/**
 * SSOT de insignias de empresas. Los estados de IO reutilizan el semáforo
 * de órdenes (`OrderStageBadge`): Borrador gris, Firmada verde, Cancelada rojo.
 */

/** Tipo de contraparte: etiqueta neutra (identidad, no estado). */
export function CompanyKindBadge({ kind }: { kind: string | null }) {
  return (
    <Badge variant="secondary" className="font-normal" title="Tipo de contraparte">
      {kindLabel(kind)}
    </Badge>
  );
}

/** Estado de una IO (draft/signed/cancelled) con la gramática de órdenes.
 *  SSOT en lib/ui-badges: ''/null = sin dato (—), nunca "Borrador" inventado. */
export function CompanyIOBadge({ status }: { status: string | null | undefined }) {
  const d = companyIoBadgeDisplay(status);
  if (d.isEmpty) {
    return (
      <Badge variant="secondary" className="font-normal" title="Estado de IO sin dato">
        —
      </Badge>
    );
  }
  if (d.stage === "cancelada") return <OrderStageBadge stage="cancelada" isDraft={false} />;
  if (!d.isDraft) return <OrderStageBadge stage="firmada" isDraft={false} />;
  return <OrderStageBadge stage="firmada" isDraft />;
}

/** Estado de campaña: activa en curso, completada quieta (SSOT en lib/ui-badges). */
export function CompanyCampaignBadge({ status }: { status: string | null | undefined }) {
  const d = campaignBadgeDisplay(status);
  if (d.label === "Activa") {
    return (
      <Badge variant="default" className="font-normal" title="Campaña en curso">
        Activa
      </Badge>
    );
  }
  if (d.label === "Completada") {
    return (
      <Badge variant="secondary" className="font-normal" title="Campaña terminada">
        Completada
      </Badge>
    );
  }
  return (
    <Badge variant={d.variant} className="font-normal" title={d.title}>
      {d.label}
    </Badge>
  );
}

/** Contacto principal: solo marca el que lo es. */
export function CompanyPrincipalBadge({ isPrimary }: { isPrimary: boolean }) {
  if (!isPrimary) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <Badge variant="success" className="font-normal" title="Contacto principal">
      Principal
    </Badge>
  );
}
