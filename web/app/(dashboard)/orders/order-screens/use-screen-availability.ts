"use client";

import { useEffect, useMemo, useState } from "react";
import { checkAvailabilityAction, getScreenOccupancyAction } from "@/lib/order-actions";
import type { ScreenConflict } from "@/lib/availability";
import { nextFreeWindow, todayLima, unionRanges, type OccupiedRange } from "@/lib/availability-utils";
import { addDays, diffDaysInclusive, formatDate } from "@/lib/format";
import { parseSlotsInput } from "@/lib/order-lines";
import type { ScreenPick } from "./types";
import { plural } from "./types";

/** Disponibilidad compartida (nueva orden + editar pantallas).
 *  Debounce 400ms: choques del periodo + ocupación de todas las pantallas.
 *  `slots`: cupo pedido por pantalla (crudo del form; inválido = 1) para
 *  choques y rangos relativos a la reserva. `excludeIoId`: editar sin
 *  chocar consigo misma (el servidor también excluye). */
export function useScreenAvailability({
  screens,
  starts,
  ends,
  slots = {},
  excludeIoId = null,
}: {
  screens: ScreenPick[];
  starts: string;
  ends: string;
  slots?: Record<string, string>;
  excludeIoId?: string | null;
}) {
  const dias = diffDaysInclusive(starts, ends);

  const [conflicts, setConflicts] = useState<ScreenConflict[]>([]);
  const [checking, setChecking] = useState(false);
  const [availError, setAvailError] = useState<string | null>(null);
  const [occupancy, setOccupancy] = useState<Record<string, OccupiedRange[]>>({});
  const [remaining, setRemaining] = useState<Record<string, Record<string, number>>>({});
  const [capacities, setCapacities] = useState<Record<string, number>>({});

  const qtyOf = (id: string): number => parseSlotsInput(slots[id]) ?? 1;
  const slotsKey = screens.map((s) => `${s.id}:${qtyOf(s.id)}`).join(",");

  useEffect(() => {
    const h = setTimeout(async () => {
      if (dias === null) {
        setConflicts([]);
        setChecking(false);
        setAvailError(null);
        return;
      }
      setChecking(true);
      try {
        const anchor = todayLima();
        const ids = screens.map((s) => s.id);
        const qtyBy: Record<string, number> = Object.fromEntries(ids.map((id) => [id, qtyOf(id)]));
        const [res, occ] = await Promise.all([
          checkAvailabilityAction({ starts, ends, screenIds: ids, slots: qtyBy, excludeIoId }),
          getScreenOccupancyAction({ screenIds: ids, from: anchor, slots: qtyBy, excludeIoId }),
        ]);
        if (res.ok) {
          setConflicts(res.conflicts);
          setRemaining(res.remaining);
          setCapacities(res.capacities);
          setAvailError(null);
        } else {
          setAvailError(res.message || "No se pudo verificar disponibilidad.");
        }
        if (occ.ok) {
          setOccupancy((prev) => {
            const next: Record<string, OccupiedRange[]> = { ...prev, ...occ.occupancy };
            for (const id of ids) next[id] ??= [];
            return next;
          });
          setCapacities((prev) => ({ ...prev, ...occ.capacities }));
        }
      } catch {
        setAvailError("No se pudo verificar disponibilidad.");
      } finally {
        setChecking(false);
      }
    }, 400);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starts, ends, dias, screens, slotsKey, excludeIoId]);

  const conflictBy = useMemo(() => {
    const m = new Map<string, ScreenConflict[]>();
    for (const c of conflicts) {
      const list = m.get(c.screen_id) ?? [];
      list.push(c);
      m.set(c.screen_id, list);
    }
    return m;
  }, [conflicts]);

  const occupiedOf = (id: string): ScreenConflict[] => conflictBy.get(id) ?? [];
  const untilOf = (id: string): string | null => {
    const list = conflictBy.get(id);
    if (!list || list.length === 0) return null;
    return list.reduce((a, b) => (a > b ? a : b)).ends;
  };
  /** Slots libres mínimos en el periodo pedido (null = sin periodo). */
  const remainingOf = (id: string): number | null => {
    if (dias === null) return null;
    const days = remaining[id];
    if (!days) return capacities[id] ?? null;
    const vals = Object.values(days);
    if (vals.length === 0) return capacities[id] ?? null;
    return Math.min(...vals);
  };
  const capacityOf = (id: string): number | null => capacities[id] ?? null;

  const occupiedCount = dias !== null ? screens.filter((s) => conflictBy.has(s.id)).length : 0;
  const periodLabel = dias !== null ? `${formatDate(starts)}→${formatDate(ends)}` : null;

  /** Próximo hueco común a las elegidas (misma duración). */
  function commonWindowFor(selectedIds: string[]): string | null {
    if (dias === null) return null;
    const rows = selectedIds.filter((id) => id in occupancy);
    if (rows.length !== selectedIds.length || selectedIds.length === 0) return null;
    const hasBlocked = selectedIds.some((id) => (conflictBy.get(id) ?? []).length > 0);
    if (!hasBlocked) return null;
    return nextFreeWindow(unionRanges(selectedIds.map((id) => occupancy[id])), starts, dias);
  }

  function nextWindowLabelFor(selectedIds: string[]): string | null {
    const w = commonWindowFor(selectedIds);
    if (!w || dias === null) return null;
    return `Mover al próximo hueco: ${formatDate(w)} → ${formatDate(addDays(w, dias - 1))}`;
  }

  /** Carga perezosa de la ocupación de una pantalla (calendario). */
  function ensureOccupancy(id: string, qty?: number) {
    if (id in occupancy) return;
    const slots = qty !== undefined ? { [id]: qty } : undefined;
    void getScreenOccupancyAction({ screenIds: [id], from: todayLima(), slots, excludeIoId }).then((res) => {
      if (res.ok) {
        setOccupancy((prev) => {
          const next: Record<string, OccupiedRange[]> = { ...prev, ...res.occupancy };
          next[id] ??= [];
          return next;
        });
        setCapacities((prev) => ({ ...prev, ...res.capacities }));
      }
    });
  }

  return {
    dias,
    conflicts,
    checking,
    availError,
    occupancy,
    setOccupancy,
    conflictBy,
    occupiedOf,
    untilOf,
    remainingOf,
    capacityOf,
    remaining,
    capacities,
    occupiedCount,
    periodLabel,
    commonWindowFor,
    nextWindowLabelFor,
    ensureOccupancy,
    plural,
  };
}
