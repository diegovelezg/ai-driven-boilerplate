"use client";

import { useMemo, useState } from "react";
import { ArrowRight, CalendarDays, Check, ChevronsUpDown, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RowIconButton } from "@/components/buttons";
import { SelectionBadge } from "@/components/badges";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "cn";
import { formatDate, formatNumber } from "@/lib/format";
import { filterPickScreens } from "@/lib/screen-pick";
import type { ScreenConflict } from "@/lib/availability";
import type { ScreenPick } from "./types";
import { plural } from "./types";

/** Combo estándar de pantallas con disponibilidad.
 *  SSOT: misma pieza en nueva orden y en editar pantallas (drawer).
 *  Ocupada = visible pero no seleccionable; calendario por fila. */
export function ScreenMultiSelect({
  screens,
  selected,
  onToggle,
  onSetAll,
  onClear,
  occupiedOf,
  untilOf,
  onShowCalendar,
  availableOnly,
  onToggleAvailableOnly,
  periodReady,
  occupiedCount,
  periodLabel,
  nextWindowLabel,
  onApplyWindow,
  availError,
  isChecking,
  disabled,
}: {
  screens: ScreenPick[];
  selected: string[];
  onToggle: (id: string) => void;
  onSetAll: (ids: string[]) => void;
  onClear: () => void;
  occupiedOf: (id: string) => ScreenConflict[];
  untilOf: (id: string) => string | null;
  onShowCalendar: (id: string) => void;
  availableOnly: boolean;
  onToggleAvailableOnly: () => void;
  periodReady: boolean;
  occupiedCount: number;
  periodLabel: string | null;
  nextWindowLabel: string | null;
  onApplyWindow: (() => void) | null;
  availError: string | null;
  isChecking: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => filterPickScreens(screens, q), [screens, q]);
  const visible = useMemo(
    () => (availableOnly && periodReady ? filtered.filter((s) => occupiedOf(s.id).length === 0) : filtered),
    [filtered, availableOnly, periodReady, occupiedOf],
  );

  const set = useMemo(() => new Set(selected), [selected]);
  const allFilteredIn = visible.length > 0 && visible.every((s) => set.has(s.id));

  const label =
    selected.length === 0
      ? "Elegir pantallas…"
      : `${formatNumber(selected.length)} seleccionada${plural(selected.length)}${
          periodReady && occupiedCount > 0 ? ` · ${formatNumber(occupiedCount)} ocupada${plural(occupiedCount)}` : ""
        }`;

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              aria-label="Elegir pantallas"
              className={cn(
                "h-9 w-full justify-between bg-background px-2.5 text-sm font-normal",
                selected.length === 0 && "text-muted-foreground",
              )}
            >
              <span className="truncate">{label}</span>
              <ChevronsUpDown aria-hidden className="shrink-0 opacity-50" />
            </Button>
          }
        />
        <PopoverContent align="start" className="w-[min(44rem,calc(100vw-3rem))] p-2">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar por nombre, código, ubicación…"
              aria-label="Buscar pantallas"
              autoComplete="off"
              className="h-9 w-full rounded-lg border border-border bg-background pr-2.5 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
            />
          </div>
          <div className="flex items-center justify-between gap-2 px-1 pt-2 pb-1">
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatNumber(visible.length)} de {formatNumber(screens.length)}
            </span>
            <div className="flex items-center gap-1">
              <label className="flex cursor-pointer items-center gap-1.5 pr-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={availableOnly}
                  onChange={onToggleAvailableOnly}
                  disabled={!periodReady}
                  aria-label="Solo disponibles en el periodo"
                  className="size-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed"
                />
                Solo disponibles
              </label>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={allFilteredIn}
                onClick={() =>
                  onSetAll([...selected, ...visible.map((s) => s.id).filter((id) => !set.has(id) && occupiedOf(id).length === 0)])
                }
              >
                <Check aria-hidden />
                Todas
              </Button>
              <Button type="button" variant="ghost" size="xs" disabled={selected.length === 0} onClick={onClear}>
                <X aria-hidden />
                Ninguna
              </Button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto" role="group" aria-label="Pantallas disponibles">
            {!periodReady && (
              <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
                Elige Inicio y Fin para ver disponibilidad.
              </p>
            )}
            {visible.map((s) => {
              const checked = set.has(s.id);
              const occupied = periodReady ? occupiedOf(s.id) : [];
              const blocked = occupied.length > 0 && !checked;
              const until = untilOf(s.id);
              const note = occupied.length > 0
                ? `No disponible · ${[occupied[0].io_number, occupied[0].brand].filter(Boolean).join(" · ") || "ocupada"}${until ? ` · hasta ${formatDate(until)}` : ""}`
                : null;
              return (
                <div
                  key={s.id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1.5",
                    blocked ? "opacity-60" : "hover:bg-muted/60",
                  )}
                >
                  <label
                    aria-disabled={blocked}
                    className={cn(
                      "flex min-w-0 flex-1 cursor-pointer items-center gap-2.5",
                      blocked && "cursor-not-allowed",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={blocked}
                      onChange={() => onToggle(s.id)}
                      aria-label={blocked ? `${s.name} (no disponible en ese periodo)` : s.name}
                      className="size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="text-xs font-medium break-words">{s.name}</span>
                        {checked && <Check aria-hidden className="size-3.5 shrink-0 text-primary" />}
                      </span>
                      {note && <span className="truncate text-xs text-destructive">{note}</span>}
                      {s.detail && (
                        <span className="text-xs text-muted-foreground break-words">{s.detail}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs font-medium tabular-nums">
                      {s.price_pen !== null ? `S/ ${formatNumber(s.price_pen)}` : "—"}
                    </span>
                  </label>
                  <RowIconButton
                    icon={CalendarDays}
                    label={`Ver disponibilidad de ${s.name}`}
                    onClick={() => onShowCalendar(s.id)}
                    className="shrink-0"
                  />
                </div>
              );
            })}
            {visible.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {availableOnly && periodReady
                  ? "Todo lo filtrado está ocupado en ese periodo. Prueba otras fechas."
                  : "Sin resultados para esa búsqueda."}
              </p>
            )}
          </div>
          {periodReady && !isChecking && !availError && occupiedCount === 0 && (
            <p className="flex items-center gap-1 px-2 text-xs text-emerald-700 tabular-nums" role="status">
              <Check aria-hidden className="size-3.5" />
              Todo libre en {periodLabel}
            </p>
          )}
          {periodReady && !isChecking && availError && (
            <p className="px-2 text-xs text-amber-700" role="alert">
              {availError} Se revalida al crear.
            </p>
          )}
          {periodReady && occupiedCount > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-destructive/5 px-2.5 py-2">
              <p className="text-xs text-destructive tabular-nums">
                {formatNumber(occupiedCount)} ocupada{plural(occupiedCount)} en {periodLabel}
              </p>
              {nextWindowLabel && onApplyWindow && (
                <Button type="button" size="xs" variant="outline" onClick={onApplyWindow}>
                  <ArrowRight aria-hidden />
                  {nextWindowLabel}
                </Button>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Pantallas elegidas">
          {selected.map((id) => {
            const s = screens.find((x) => x.id === id);
            if (!s) return null;
            return (
              <SelectionBadge
                key={id}
                label={s.name}
                removeLabel={`Quitar ${s.name}`}
                onRemove={() => onToggle(id)}
                disabled={disabled}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
