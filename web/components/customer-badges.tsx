import { Badge } from "@/components/ui/badge";

/**
 * SSOT de insignias de customers. Semáforo de estados de contacto y
 * decisión del motor; tipo y categoría como etiquetas neutras.
 */

/** Tipo B2B: etiqueta neutra (identidad, no estado). */
export function CustomerTypeBadge() {
  return (
    <Badge variant="secondary" className="font-normal" title="Empresa B2B">
      B2B · Empresa
    </Badge>
  );
}

type BadgeVariant = "default" | "secondary" | "success" | "destructive" | "outline";

/** Decisión del motor: en curso (actuar) en primary, logro en verde,
 *  bloqueo sin canal en rojo, resto neutro. */
export function CustomerDecisionBadge({ decision }: { decision: string | null | undefined }) {
  const d = String(decision ?? "");
  const label =
    d === "actuar"
      ? "Para actuar"
      : d === "revision_humana"
        ? "Revisar 1 a 1"
        : d === "vigilar"
          ? "Vigilar"
          : d === "organico"
            ? "Volverá solo"
            : d === "dormido"
              ? "Dormido"
              : d === "sin_canal"
                ? "Sin canal"
                : d === "contactado_reciente"
                  ? "Contactado"
                  : null;
  if (!label) return null;
  const variant: BadgeVariant =
    d === "actuar"
      ? "default"
      : d === "organico"
        ? "success"
        : d === "sin_canal"
          ? "destructive"
          : d === "revision_humana"
            ? "outline"
            : "secondary";
  return (
    <Badge variant={variant} className="font-normal" title="Decisión del motor">
      {label}
    </Badge>
  );
}

const CONTACT_STATUS_LABEL: Record<string, string> = {
  dispatched: "Enviado",
  approved: "Aprobado, esperando envío",
  pending_review: "Borrador sin aprobar",
  rejected: "Rechazado",
  contacted: "Contactado por mi cuenta",
  discarded: "Descartado",
};

const CONTACT_STATUS_VARIANT: Record<string, BadgeVariant> = {
  dispatched: "success",
  approved: "default",
  pending_review: "outline",
  rejected: "destructive",
  contacted: "secondary",
  discarded: "destructive",
};

/** Estado de un mensaje: enviado verde, aprobado primary, borrador pendiente
 *  outline, rechazado/descartado rojo. */
export function CustomerContactStatusBadge({ status }: { status: string | null | undefined }) {
  const s = String(status ?? "");
  return (
    <Badge
      variant={CONTACT_STATUS_VARIANT[s] ?? "secondary"}
      className="font-normal"
      title="Estado del mensaje"
    >
      {CONTACT_STATUS_LABEL[s] ?? s ?? "—"}
    </Badge>
  );
}

/** Categoría del ítem comprado: etiqueta neutra con acento primario. */
export function CustomerCategoryBadge({ label }: { label: string }) {
  return (
    <Badge
      variant="secondary"
      className="border-primary/30 bg-primary/10 align-middle text-[11px] font-normal text-primary"
      title="Categoría del ítem"
    >
      {label}
    </Badge>
  );
}
