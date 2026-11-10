import type { ReactNode } from "react";
import { FilterX, LayoutGrid, List, Loader2, Pencil, RotateCcw, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { cn } from "cn";

/**
 * SSOT de botones semánticos.
 * Toda vista usa uno de estos. Prohibido componer `variant=` + `size=`
 * con lógica inline en vistas, prohibido `hover:` / `text-*` manual
 * sobre botones, prohibido `<button>` crudo para acciones estándar
 * (SortHeaderButton, tabs, stepper y triggers posicionados son la
 * excepción documentada: llevan su propio foco).
 *
 * Recetas congeladas:
 * - Reintentar: outline + sm + w-fit + RotateCcw (+ spinner en pending).
 * - Limpiar filtros: ghost + sm (xs solo en popovers) + FilterX.
 * - Vista lista/grilla: icon + default/outline + aria-pressed + tooltip.
 * - Segmentado (7/14/28d): default/outline + sm.
 * - Submit: default + disabled hasta completar + title qué falta + spinner en pending
 *   (size sm solo en footers compactos: invoice-form).
 * - Cancelar: outline + X (size sm solo en footers compactos).
 * - Acción de fila icon-only: ghost + icon-sm + aria-label + title + spinner en pending;
 *   `danger` tiñe a destructive (eliminar, cancelar orden).
 * - Acción destructiva con etiqueta: variant destructive + sm + spinner en pending.
 * - Link inline: variant link.
 */

/** Reintentar tras error (drawers + research). */
export function RetryButton({
  onRetry,
  label = "Reintentar",
  pending,
  pendingLabel = "Reintentando…",
  disabled,
  className,
}: {
  onRetry: () => void;
  label?: string;
  pending?: boolean;
  pendingLabel?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("w-fit", className)}
      onClick={onRetry}
      disabled={pending || disabled}
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
      {pending ? pendingLabel : label}
    </Button>
  );
}

/** Limpiar filtros (listas). xs solo dentro de popovers compactos. */
export function ClearFiltersButton({
  onClear,
  disabled,
  label = "Limpiar",
  size = "sm",
  className,
}: {
  onClear: () => void;
  disabled?: boolean;
  label?: string;
  size?: "sm" | "xs";
  className?: string;
}) {
  return (
    <Button variant="ghost" size={size} disabled={disabled} onClick={onClear} className={className}>
      <FilterX aria-hidden />
      {label}
    </Button>
  );
}

/** Toggle vista lista/grilla (listas). */
export function ViewToggle({
  view,
  onChange,
  tableLabel = "Vista lista",
  gridLabel = "Vista grilla",
}: {
  view: "table" | "grid";
  onChange: (view: "table" | "grid") => void;
  tableLabel?: string;
  gridLabel?: string;
}) {
  return (
    <span className="flex items-center gap-1" role="group" aria-label="Cambiar vista">
      <AppTooltip tip={tableLabel}>
        <Button
          size="icon"
          variant={view === "table" ? "default" : "outline"}
          onClick={() => onChange("table")}
          aria-pressed={view === "table"}
          aria-label={tableLabel}
        >
          <List aria-hidden />
        </Button>
      </AppTooltip>
      <AppTooltip tip={gridLabel}>
        <Button
          size="icon"
          variant={view === "grid" ? "default" : "outline"}
          onClick={() => onChange("grid")}
          aria-pressed={view === "grid"}
          aria-label={gridLabel}
        >
          <LayoutGrid aria-hidden />
        </Button>
      </AppTooltip>
    </span>
  );
}

/** Segmentado genérico (píldoras 7/14/28d en occupancy). */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <span className="flex items-center gap-1" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <Button
          key={String(o.value)}
          type="button"
          variant={value === o.value ? "default" : "outline"}
          size="sm"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
        >
          {o.label}
        </Button>
      ))}
    </span>
  );
}

/** Submit de form: default + disabled hasta completar + title qué falta. */
export function SubmitButton({
  pending,
  disabled,
  title,
  type = "submit",
  onClick,
  pendingLabel = "Guardando…",
  size = "default",
  children,
  className,
}: {
  pending?: boolean;
  disabled?: boolean;
  title?: string;
  type?: "submit" | "button";
  onClick?: () => void;
  pendingLabel?: ReactNode;
  size?: "default" | "sm";
  children: ReactNode;
  className?: string;
}) {
  return (
    <Button type={type} size={size} disabled={pending || disabled} title={title} onClick={onClick} className={className}>
      {pending ? (
        <>
          <Loader2 className="animate-spin" aria-hidden />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/** Cancelar edición (forms). */
export function CancelButton({
  onCancel,
  disabled,
  label = "Cancelar",
  size = "default",
  className,
}: {
  onCancel: (() => void) | undefined;
  disabled?: boolean;
  label?: string;
  size?: "default" | "sm";
  className?: string;
}) {
  return (
    <Button variant="outline" size={size} onClick={onCancel} disabled={disabled} className={className}>
      <X aria-hidden />
      {label}
    </Button>
  );
}

/** Editar (acción de AppCard en drawers). */
export function EditButton({
  onEdit,
  label = "Editar",
  disabled,
  className,
}: {
  onEdit: () => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onEdit} disabled={disabled} className={className}>
      <Pencil aria-hidden />
      {label}
    </Button>
  );
}

/** Acción de fila icon-only: ver, quitar, eliminar + spinner en pending. `danger` = rojo. */
export function RowIconButton({
  icon: Icon,
  label,
  title,
  onClick,
  disabled,
  pending,
  danger,
  type = "button",
  className,
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  danger?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <Button
      type={type}
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      disabled={pending || disabled}
      className={cn(danger && "text-destructive hover:text-destructive", className)}
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Icon aria-hidden />}
    </Button>
  );
}

/** Acción destructiva con etiqueta (eliminar, cancelar orden). */
export function DangerButton({
  onClick,
  disabled,
  pending,
  pendingLabel,
  children,
  className,
}: {
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  pendingLabel?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Button variant="destructive" size="sm" onClick={onClick} disabled={pending || disabled} className={className}>
      {pending ? (
        <>
          <Loader2 className="animate-spin" aria-hidden />
          {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/** Link inline (limpiar punto del mapa, etc.). Rescata variant="link". */
export function LinkButton({
  onClick,
  children,
  className,
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Button variant="link" onClick={onClick} className={cn("h-auto p-0 text-[11px]", className)}>
      {children}
    </Button>
  );
}
