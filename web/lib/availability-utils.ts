// Utilidades puras de disponibilidad (sin imports de servidor: se usan en cliente).
// Rangos ocupados con días inclusivos "yyyy-mm-dd".
// SSOT de fechas en lib/format.ts: los primitivos (todayLima, addDays,
// día↔ordinal) viven ahí; aquí solo la lógica de huecos. Se re-exportan
// para compatibilidad con los imports existentes.
import { dayNumToISO, isoDayToNum } from "@/lib/format";

export { addDays, todayLima } from "@/lib/format";

export interface OccupiedRange {
  starts: string;
  ends: string;
}

/** ¿El día está cubierto por algún rango ocupado? */
function covered(ranges: OccupiedRange[], dayNum: number): boolean {
  return ranges.some((r) => isoDayToNum(r.starts) <= dayNum && dayNum <= isoDayToNum(r.ends));
}

/** Primer día libre ≥ from (horizonte 400 días). null si no hay. */
export function firstFreeDay(ranges: OccupiedRange[], from: string, horizon = 400): string | null {
  const start = isoDayToNum(from);
  for (let s = start; s <= start + horizon; s++) {
    if (!covered(ranges, s)) return dayNumToISO(s);
  }
  return null;
}

/** Próxima ventana de `duration` días libres desde `from` (horizonte 365 días).
 *  Devuelve el inicio "yyyy-mm-dd" o null. */
export function nextFreeWindow(
  ranges: OccupiedRange[],
  from: string,
  duration: number,
  horizon = 365,
): string | null {
  if (duration < 1) return null;
  const start = isoDayToNum(from);
  outer: for (let s = start; s <= start + horizon; s++) {
    for (let d = 0; d < duration; d++) {
      if (covered(ranges, s + d)) continue outer;
    }
    return dayNumToISO(s);
  }
  return null;
}

/** Unión de rangos (para el hueco común de varias pantallas). */
export function unionRanges(lists: OccupiedRange[][]): OccupiedRange[] {
  return lists.flat();
}
