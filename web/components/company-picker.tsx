"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FIELD_ERR_CLS } from "@/components/ui/form-feedback";
import { filterPickCompanies } from "@/lib/company-pick";
import { toTitleCase } from "@/lib/format";
import { cn } from "cn";

export interface CompanyPickerOption {
  id: string;
  name: string;
  tax_id?: string | null;
  domain?: string | null;
  city?: string | null;
  kind?: string | null;
}

/**
 * SSOT del selector único de empresas con búsqueda.
 * Extraído del `ScreenMultiSelect` de nueva orden, sin lo específico de
 * pantallas (multi, disponibilidad, calendario): trigger + buscador +
 * lista de un solo pick. El trigger jamás muestra un id crudo (regla del
 * `AppSelect`): vacío = placeholder.
 *
 * Dos modos:
 * - cliente (default): filtra `options` en memoria con `filterPickCompanies`.
 * - servidor: el padre pasa `onQueryChange` (debounce interno 300ms, patrón
 *   de `FilterSearch`) y repone `options` con el top-N del servidor
 *   (`GET /api/companies/search`); no se refiltra localmente.
 */
export function CompanyPicker({
  value,
  onChange,
  options,
  placeholder = "Elegir empresa…",
  searchPlaceholder = "Buscar por nombre, ID fiscal, web…",
  ariaLabel,
  disabled,
  invalid,
  emptyText = "Sin resultados para esa búsqueda.",
  allowClear = true,
  clearLabel = "Sin definir",
  selectedLabel,
  loading = false,
  onQueryChange,
  queryDelay = 300,
  dataField,
}: {
  value: string;
  onChange: (id: string) => void;
  options: CompanyPickerOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  invalid?: boolean;
  emptyText?: string;
  allowClear?: boolean;
  clearLabel?: string;
  /** Etiqueta cuando el id elegido no viene en `options` (modo servidor). */
  selectedLabel?: string;
  loading?: boolean;
  /** Modo servidor: se avisa el query con debounce; el padre repone `options`. */
  onQueryChange?: (q: string) => void;
  queryDelay?: number;
  /** `data-field` del trigger (foco programático del forms default). */
  dataField?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const serverMode = typeof onQueryChange === "function";
  const onQueryRef = useRef(onQueryChange);
  useEffect(() => {
    onQueryRef.current = onQueryChange;
  }, [onQueryChange]);

  useEffect(() => {
    if (!serverMode || !open) return;
    const t = setTimeout(() => onQueryRef.current?.(q), queryDelay);
    return () => clearTimeout(t);
  }, [q, open, serverMode, queryDelay]);

  const visible = useMemo(
    () => (serverMode ? options : filterPickCompanies(options, q)),
    [options, q, serverMode],
  );

  const selected = value !== "" ? options.find((o) => o.id === value) : undefined;
  const triggerLabel = selected ? toTitleCase(selected.name) : (selectedLabel ?? placeholder);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={ariaLabel}
            aria-invalid={invalid}
            data-field={dataField}
            className={cn(
              "h-9 w-full justify-between bg-background px-2.5 text-sm font-normal",
              value === "" && "text-muted-foreground",
              invalid && FIELD_ERR_CLS,
            )}
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown aria-hidden className="shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-3rem))] p-2">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && q) setQ("");
            }}
            placeholder={searchPlaceholder}
            aria-label={`Buscar ${ariaLabel}`}
            autoComplete="off"
            disabled={disabled}
            className="h-9 w-full rounded-lg border border-border bg-background pr-2.5 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
          />
        </div>
        <div className="flex items-center justify-between gap-2 px-1 pt-2 pb-1">
          <span className="text-xs text-muted-foreground tabular-nums" role="status">
            {loading ? "Buscando…" : `${visible.length} resultado${visible.length === 1 ? "" : "s"}`}
          </span>
          {allowClear && value !== "" && (
            <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => pick("")}>
              <X aria-hidden />
              {clearLabel}
            </Button>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto" role="listbox" aria-label={ariaLabel}>
          {visible.map((o) => {
            const active = o.id === value;
            const detail = [o.tax_id, o.domain, o.city].filter((v) => typeof v === "string" && v.trim()).join(" · ");
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={active}
                disabled={disabled}
                onClick={() => pick(o.id)}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{toTitleCase(o.name)}</span>
                    {active && <Check aria-hidden className="size-3.5 shrink-0 text-primary" />}
                  </span>
                  {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
                </span>
              </button>
            );
          })}
          {!loading && visible.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">{emptyText}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
