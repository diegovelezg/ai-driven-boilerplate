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
import { addDays, formatDate, formatNumber, parseISODate, todayLima } from "@/lib/format";
import { firstFreeDay, nextFreeWindow, type OccupiedRange } from "@/lib/availability-utils";
import type { ScreenPick } from "./types";
import { plural } from "./types";

/** Calendario de disponibilidad de una pantalla: ocupado tachado, periodo elegido en rango.
 *  SSOT: misma pieza en nueva orden y en editar pantallas (drawer). */
export function ScreenCalendarDialog({
  screen,
  ranges,
  loaded,
  duration,
  periodStarts,
  periodEnds,
  onApply,
  onClose,
}: {
  screen: ScreenPick | null;
  ranges: OccupiedRange[] | undefined;
  loaded: boolean;
  duration: number;
  periodStarts: string;
  periodEnds: string;
  onApply: (starts: string) => void;
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
            <Calendar
              mode="range"
              locale={es}
              selected={periodFrom ? { from: periodFrom, to: periodTo } : undefined}
              modifiers={{ booked }}
              modifiersClassNames={{ booked: "bg-destructive/10 text-destructive line-through" }}
              disabled={booked}
            />
            <p className="text-xs text-muted-foreground tabular-nums">
              <span className="mr-1 inline-block size-2.5 rounded-sm bg-destructive/20 align-middle" aria-hidden />
              ocupado · libre desde {free ? formatDate(free) : "—"}
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
