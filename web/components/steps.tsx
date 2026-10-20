"use client";

import { CheckIcon } from "lucide-react";
import { cn } from "cn";

/** Indicador de wizard compartido (settings y donde haga falta).
 *  `current` = índice del paso activo (0-based); `current === steps.length`
 *  = todo completo (resumen). `onGo` habilita volver a pasos anteriores. */
export function Steps({
  steps,
  current,
  onGo,
}: {
  steps: string[];
  current: number;
  onGo?: (index: number) => void;
}) {
  return (
    <ol className="flex w-full items-start gap-1" aria-label="Progreso">
      {steps.map((label, i) => {
        const done = i < current || current >= steps.length;
        const active = i === current && current < steps.length;
        const clickable = !!onGo && i !== current && (i < current || current >= steps.length);
        return (
          <li key={label} className="flex min-w-0 flex-1 items-start gap-1.5 last:flex-none">
            <div className="flex min-w-0 flex-col items-center gap-1">
              <button
                type="button"
                disabled={!clickable}
                onClick={() => onGo?.(i)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                  done && "border-primary bg-primary text-primary-foreground",
                  active && "border-primary text-primary ring-2 ring-primary/30",
                  !done && !active && "border-border text-muted-foreground",
                  clickable && "cursor-pointer hover:border-primary",
                )}
              >
                {done ? <CheckIcon className="size-3.5" aria-hidden /> : <span>{i + 1}</span>}
              </button>
              <span
                className={cn(
                  "max-w-full truncate text-[11px]",
                  active ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                aria-hidden
                className={cn("mt-3 h-px min-w-3 flex-1", i < current ? "bg-primary" : "bg-border")}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
