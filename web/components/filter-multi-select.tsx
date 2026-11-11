"use client";

import { useState } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { cn } from "cn";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * SSOT del filtro multiselect (checkboxes en popover).
 * Trigger con el mismo lenguaje visual que FilterSelect (borde h-9 text-sm).
 * Cierra al aplicar; "Todos" / "Ninguno" como atajos.
 */
export function FilterMultiSelect<T extends string>({
  values,
  options,
  onChange,
  ariaLabel,
  placeholder,
  display,
  disabled,
}: {
  values: readonly T[];
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T[]) => void;
  ariaLabel: string;
  placeholder?: string;
  display?: (values: readonly T[]) => string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const set = new Set<string>(values);
  const label = display
    ? display(values)
    : values.length === 0
      ? (placeholder ?? "Sin selección")
      : values.length === options.length
        ? "Todos"
        : `${values.length} seleccionados`;

  const toggle = (v: T) => {
    const next = new Set<string>(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(options.map((o) => o.value).filter((x) => next.has(x)));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            aria-label={ariaLabel}
            className={cn(
              "flex h-9 w-fit max-w-64 items-center justify-between gap-1.5 rounded-md border border-input bg-input/20 px-3 py-1.5 text-sm/relaxed whitespace-nowrap transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
              values.length === 0 && "text-muted-foreground",
            )}
          >
            <span className="truncate">{label}</span>
            <CaretDownIcon aria-hidden className="text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent align="start" className="w-56 gap-1 p-1.5">
        <div className="flex items-center justify-between px-1 pt-0.5 pb-1">
          <span className="text-xs text-muted-foreground tabular-nums">
            {values.length} de {options.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onChange(options.map((o) => o.value))}
              disabled={values.length === options.length}
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              Todos
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={values.length === 0}
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              Ninguno
            </button>
          </div>
        </div>
        <div role="group" aria-label={ariaLabel} className="flex flex-col">
          {options.map((o) => {
            const checked = set.has(o.value);
            const id = `fms-${o.value}`;
            return (
              <label
                key={o.value}
                htmlFor={id}
                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm hover:bg-muted/60"
              >
                <Checkbox
                  id={id}
                  checked={checked}
                  onCheckedChange={() => toggle(o.value)}
                  aria-label={o.label}
                />
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate">{o.label}</span>
                  {checked && <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />}
                </span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
