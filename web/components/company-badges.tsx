import { Badge } from "@/components/ui/badge";
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

/** Estado de una IO (draft/signed/cancelled) con la gramática de órdenes. */
export function CompanyIOBadge({ status }: { status: string | null | undefined }) {
  const s = String(status ?? "");
  if (s === "cancelled") return <OrderStageBadge stage="cancelada" isDraft={false} />;
  if (s === "signed") return <OrderStageBadge stage="firmada" isDraft={false} />;
  return <OrderStageBadge stage="firmada" isDraft />;
}

/** Estado de campaña: activa en curso, completada quieta. */
export function CompanyCampaignBadge({ status }: { status: string | null | undefined }) {
  const s = String(status ?? "").toLowerCase();
  if (s === "active") {
    return (
      <Badge variant="default" className="font-normal" title="Campaña en curso">
        Activa
      </Badge>
    );
  }
  if (s === "completed") {
    return (
      <Badge variant="secondary" className="font-normal" title="Campaña terminada">
        Completada
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-normal" title="Estado de campaña">
      {s || "—"}
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
