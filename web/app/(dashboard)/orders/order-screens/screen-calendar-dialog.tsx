"use client";

import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DrawerDialogContent as DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { es } from "react-day-picker/locale";
import { addDays, formatDate, formatNumber, parseISODate, toISODateLocal, todayLima } from "@/lib/format";
import { firstFreeDay, nextFreeWindow, type OccupiedRange } from "@/lib/availability-utils";
import type { ScreenPick } from "./types";
import { plural } from "./types";

/** Calendario de disponibilidad de una pantalla: sin cupo tachado, periodo elegido en rango.
 *  Los rangos son relativos al cupo pedido (`slots` del caller vía occupancy).
 *  SSOT: misma pieza en nueva orden y en editar pantallas (drawer). */
export function ScreenCalendarDialog({
  screen,
  ranges,
  loaded,
  duration,
  periodStarts,
  periodEnds,
  capacity,
  minFree,
  onApply,
  onSelectRange,
  onClose,
}: {
  screen: ScreenPick | null;
  ranges: OccupiedRange[] | undefined;
  loaded: boolean;
  duration: number;
  periodStarts: string;
  periodEnds: string;
  /** Capacidad slots/día (null = aún sin dato). */
  capacity?: number | null;
  /** Slots libres mínimos en el periodo pedido (null = sin periodo). */
  minFree?: number | null;
  onApply: (starts: string) => void;
  /** Fija el periodo de la orden al rango elegido (días y subtotales recalculan). */
  onSelectRange?: (from: string, to: string) => void;
  onClose: () => void;
}) {
  const booked = (ranges ?? []).flatMap((r) => {
    const from = parseISODate(r.starts);
    const to = parseISODate(r.ends);
    return from && to ? [{ from, to }] : [];
  });
  const periodFrom = parseISODate(periodStarts);
  const periodTo = parseISODate(periodEnds);
  const today = todayLima();
  const free = screen && loaded && ranges ? firstFreeDay(ranges, today) : null;
  const windowStart = screen && loaded && ranges && duration > 0
    ? nextFreeWindow(ranges, today, duration)
    : null;

  return (
    <Dialog open={screen !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-auto max-w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>{screen?.name ?? "Disponibilidad"}</DialogTitle>
          <DialogDescription>
            {screen?.detail ?? ""}
            {loaded && ranges && ranges.length === 0 && " · libre en todo lo visible."}
          </DialogDescription>
        </DialogHeader>
        {!loaded || !ranges ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Cargando disponibilidad…</p>
        ) : (
          <div className="flex flex-col gap-2">
            {onSelectRange && (
              <p className="text-xs text-muted-foreground">
                Elige un rango para fijar el periodo de la orden (días y montos recalculan).
              </p>
            )}
            <Calendar
              mode="range"
              locale={es}
              selected={periodFrom ? { from: periodFrom, to: periodTo } : undefined}
              modifiers={{ booked }}
              modifiersClassNames={{ booked: "bg-destructive/10 text-destructive line-through" }}
              disabled={booked}
              onSelect={(range) => {
                const from = range?.from;
                if (!from || !onSelectRange) return;
                const to = range.to ?? from;
                onSelectRange(toISODateLocal(from), toISODateLocal(to));
              }}
            />
            <p className="text-xs text-muted-foreground tabular-nums">
              <span className="mr-1 inline-block size-2.5 rounded-sm bg-destructive/20 align-middle" aria-hidden />
              sin cupo · libre desde {free ? formatDate(free) : "—"}
              {capacity !== undefined && capacity !== null && (
                <> · {minFree !== undefined && minFree !== null ? `quedan ${formatNumber(minFree)} de ${formatNumber(capacity)} slots en el periodo` : `${formatNumber(capacity)} slots/día`}</>
              )}
              {windowStart && (
                <> · hueco de {formatNumber(duration)} día{plural(duration)}: {formatDate(windowStart)}</>
              )}
            </p>
            {windowStart && (
              <div>
                <Button type="button" size="sm" variant="outline" onClick={() => onApply(windowStart)}>
                  <CalendarDays aria-hidden />
                  Usar {formatDate(windowStart)} → {formatDate(addDays(windowStart, duration - 1))}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
