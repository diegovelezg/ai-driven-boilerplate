"use client";

import { useEffect, useMemo, useState } from "react";
import { checkAvailabilityAction, getScreenOccupancyAction } from "@/lib/order-actions";
import type { ScreenConflict } from "@/lib/availability";
import { nextFreeWindow, todayLima, unionRanges, type OccupiedRange } from "@/lib/availability-utils";
import { addDays, diffDaysInclusive, formatDate } from "@/lib/format";
import type { ScreenPick } from "./types";
import { plural } from "./types";

/** Disponibilidad compartida (nueva orden + editar pantallas).
 *  Debounce 400ms: choques del periodo + ocupación de todas las pantallas.
 *  `excludeIoId`: editar sin chocar consigo misma (el servidor también excluye). */
export function useScreenAvailability({
  screens,
  starts,
  ends,
  excludeIoId = null,
}: {
  screens: ScreenPick[];
  starts: string;
  ends: string;
  excludeIoId?: string | null;
}) {
  const dias = diffDaysInclusive(starts, ends);

  const [conflicts, setConflicts] = useState<ScreenConflict[]>([]);
  const [checking, setChecking] = useState(false);
  const [availError, setAvailError] = useState<string | null>(null);
  const [occupancy, setOccupancy] = useState<Record<string, OccupiedRange[]>>({});

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
        const [res, occ] = await Promise.all([
          checkAvailabilityAction({ starts, ends, excludeIoId }),
          getScreenOccupancyAction({ screenIds: ids, from: anchor, excludeIoId }),
        ]);
        if (res.ok) {
          setConflicts(res.conflicts);
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
        }
      } catch {
        setAvailError("No se pudo verificar disponibilidad.");
      } finally {
        setChecking(false);
      }
    }, 400);
    return () => clearTimeout(h);
  }, [starts, ends, dias, screens, excludeIoId]);

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
  function ensureOccupancy(id: string) {
    if (id in occupancy) return;
    void getScreenOccupancyAction({ screenIds: [id], from: todayLima(), excludeIoId }).then((res) => {
      if (res.ok) {
        setOccupancy((prev) => {
          const next: Record<string, OccupiedRange[]> = { ...prev, ...res.occupancy };
          next[id] ??= [];
          return next;
        });
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
    occupiedCount,
    periodLabel,
    commonWindowFor,
    nextWindowLabelFor,
    ensureOccupancy,
    plural,
  };
}
