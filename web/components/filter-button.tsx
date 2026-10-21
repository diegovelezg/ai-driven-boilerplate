"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";

/**
 * SSOT del botón toggle de filtro (filtros de Customers).
 * Activo = sólido primario, inactivo = outline — mismo `size="sm"`
 * y font que `FilterSelect`. Con `tip` muestra tooltip (patrón actual).
 */
export function FilterToggleButton({
  active,
  onClick,
  disabled,
  tip,
  ariaLabel,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  tip?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const btn = (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
    >
      {children}
    </Button>
  );
  if (!tip) return btn;
  return (
    <AppTooltip tip={tip}>
      <span className="inline-flex">{btn}</span>
    </AppTooltip>
  );
}
