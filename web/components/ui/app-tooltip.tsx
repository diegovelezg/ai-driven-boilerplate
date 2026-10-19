"use client";

import type { ReactElement, ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * SSOT de tooltips de la app.
 *
 * Todo tooltip visible usa el nativo de shadcn (`components/ui/tooltip`,
 * Base UI). Prohibido `title=` nativo: es inconsistente (estilo del
 * navegador) y duplica el mensaje junto al tooltip real.
 *
 * - `AppTooltipProvider`: montarlo UNA vez (dashboard layout). Fija el
 *   `delay` global para que todos abran igual y el grupo abra al instante.
 * - `AppTooltip`: `tip` + UN hijo (single element). Sin `tip` devuelve el
 *   hijo sin envolver (útil para mensajes condicionales tipo `blocker`).
 * - El hijo se fusiona como trigger vía `render` (sin DOM extra, sin
 *   cambios de layout). Excepción: `Button` deshabilitado lleva
 *   `pointer-events-none`, así que NO dispara hover — en ese caso pasar
 *   como hijo un `<span className="inline-flex …">` que envuelva al botón.
 */

export const APP_TOOLTIP_DELAY = 300;

export function AppTooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipProvider delay={APP_TOOLTIP_DELAY}>{children}</TooltipProvider>;
}

type Side = React.ComponentProps<typeof TooltipContent>["side"];
type Align = React.ComponentProps<typeof TooltipContent>["align"];

export function AppTooltip({
  tip,
  children,
  side = "top",
  align = "center",
  sideOffset = 4,
  contentClassName,
}: {
  /** Contenido del tooltip. Falsy = sin tooltip (hijo sin envolver). */
  tip: ReactNode;
  /** Trigger: UN solo elemento (se fusiona vía `render`). */
  children: ReactElement;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  contentClassName?: string;
}) {
  if (tip === null || tip === undefined || tip === false || tip === "") return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        className={contentClassName}
      >
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}
