import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "cn";
import {
  archivedBadgeDisplay,
  attributeDisplay,
  brandPautaDisplay,
  generatingBadgeDisplay,
  historyBadgeDisplay,
  occupancyBadgeDisplay,
  screenActiveDisplay,
  selectionBadgeDisplay,
  upcomingBadgeDisplay,
} from "@/lib/ui-badges";

/**
 * Badges genéricos (SSOT de componentes).
 * Toda vista que necesite un badge fuera de órdenes/empresas usa uno de
 * estos. Prohibido `<Badge variant="...">` inline con lógica propia:
 * el color vive en `lib/ui-badges.tsx`, aquí solo se compone.
 */

/** Archivo: contacto (masc.) o empresa (fem.). */
export function ArchivedBadge({ fem = false, className }: { fem?: boolean; className?: string }) {
  const d = archivedBadgeDisplay(fem);
  return (
    <Badge variant={d.variant} className={cn("font-normal", className)} title={d.title}>
      {d.label}
    </Badge>
  );
}

/** Pantalla activa/inactiva. */
export function ScreenActiveBadge({ isActive, className }: { isActive: boolean; className?: string }) {
  const d = screenActiveDisplay(isActive);
  return (
    <Badge variant={d.variant} className={cn("font-normal", className)} title={d.title}>
      {d.label}
    </Badge>
  );
}

/** Marca con/sin pauta vigente. */
export function BrandPautaBadge({ active, className }: { active: boolean; className?: string }) {
  const d = brandPautaDisplay(active);
  return (
    <Badge variant={d.variant} className={cn("font-normal", className)} title={d.title}>
      {d.label}
    </Badge>
  );
}

/** Atributo / identidad neutra: kind, rol, medio, fuente, tag, tipo material. */
export function AttributeBadge({
  label,
  title,
  className,
  children,
}: {
  label?: string;
  title: string;
  className?: string;
  children?: ReactNode;
}) {
  const d = attributeDisplay(label ?? String(children ?? ""), title);
  return (
    <Badge variant={d.variant} className={cn("font-normal", className)} title={d.title}>
      {children ?? d.label}
    </Badge>
  );
}

/** Ocupación futura o actual de pantalla (order | booking). */
export function OccupancyBadge({
  status,
  source,
  label,
  className,
}: {
  status: string;
  source: "order" | "booking";
  label: string;
  className?: string;
}) {
  const d = occupancyBadgeDisplay(status, source);
  return (
    <Badge variant={d.variant} className={cn("font-normal", className)} title={label}>
      {label}
    </Badge>
  );
}

/** Historial vencido: quieto. */
export function HistoryBadge({ label, className }: { label: string; className?: string }) {
  const d = historyBadgeDisplay(label);
  return (
    <Badge variant={d.variant} className={cn("shrink-0 font-normal", className)} title={label}>
      {d.label}
    </Badge>
  );
}

/** Hito próximo ≤30d. */
export function UpcomingBadge({ className }: { className?: string }) {
  const d = upcomingBadgeDisplay();
  return (
    <Badge variant={d.variant} className={cn("font-normal", className)} title={d.title}>
      {d.label}
    </Badge>
  );
}

/** Transitorio IA (pulso). */
export function GeneratingBadge({ className }: { className?: string }) {
  const d = generatingBadgeDisplay();
  return (
    <Badge
      variant={d.variant}
      className={cn("font-normal motion-safe:animate-pulse", className)}
      title={d.title}
    >
      {d.label}
    </Badge>
  );
}

/** Selección con X (pantallas elegidas): protagonista azul. */
export function SelectionBadge({
  label,
  onRemove,
  removeLabel,
  disabled,
  className,
}: {
  label: string;
  onRemove: () => void;
  removeLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const d = selectionBadgeDisplay();
  return (
    <Badge variant={d.variant} className={cn("gap-1 pr-1 font-normal", className)}>
      <span className="max-w-[220px] truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={removeLabel}
        className="rounded-full p-0.5 hover:bg-primary-foreground/20"
      >
        <X aria-hidden className="size-3" />
      </button>
    </Badge>
  );
}
