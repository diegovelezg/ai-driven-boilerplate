import { Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { attributeDisplay } from "@/lib/ui-badges";
import { MEMBER_ROLE_LABELS, hasMinRole, MEMBER_ROLES, type MemberRole } from "@/lib/roles";
import { cn } from "cn";

/**
 * SSOT para visibilidad restringida por rol.
 * Marca secciones/campos que solo ven ciertos roles (p. ej. Comisión agencia
 * solo para owner/admin) para evitar suspicacias: quien no lo ve sabe que
 * existe y por qué no lo ve; quien lo ve sabe que es confidencial.
 */
export function RestrictedVisibilityBadge({
  minRole,
  className,
}: {
  /** Rol mínimo para ver el contenido (jerarquía owner > admin > seller > viewer). */
  minRole: MemberRole;
  className?: string;
}) {
  const allowed = MEMBER_ROLES.filter((r) => hasMinRole(r, minRole))
    .map((r) => MEMBER_ROLE_LABELS[r])
    .join(" · ");
  const d = attributeDisplay(
    `Solo ${allowed}`,
    `Solo visible para: ${allowed}. Contenido restringido por rol.`,
  );
  return (
    <Badge
      variant={d.variant}
      className={cn("font-normal", className)}
      title={d.title}
      aria-label={`Visibilidad restringida: solo ${allowed}`}
    >
      <Eye className="size-2.5" aria-hidden />
      {d.label}
    </Badge>
  );
}
