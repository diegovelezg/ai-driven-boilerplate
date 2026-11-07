// Utilidades puras de disponibilidad (sin imports de servidor: se usan en cliente).
// Rangos ocupados con días inclusivos "yyyy-mm-dd".
export interface OccupiedRange {
  starts: string;
  ends: string;
}

/** Hoy en Lima como "yyyy-mm-dd". */
export function todayLima(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
}

function toNum(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function toDay(num: number): string {
  const d = new Date(num * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Suma N días a un "yyyy-mm-dd". */
export function addDays(day: string, n: number): string {
  return toDay(toNum(day) + n);
}

/** ¿El día está cubierto por algún rango ocupado? */
function covered(ranges: OccupiedRange[], dayNum: number): boolean {
  return ranges.some((r) => toNum(r.starts) <= dayNum && dayNum <= toNum(r.ends));
}

/** Primer día libre ≥ from (horizonte 400 días). null si no hay. */
export function firstFreeDay(ranges: OccupiedRange[], from: string, horizon = 400): string | null {
  const start = toNum(from);
  for (let s = start; s <= start + horizon; s++) {
    if (!covered(ranges, s)) return toDay(s);
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
  const start = toNum(from);
  outer: for (let s = start; s <= start + horizon; s++) {
    for (let d = 0; d < duration; d++) {
      if (covered(ranges, s + d)) continue outer;
    }
    return toDay(s);
  }
  return null;
}

/** Unión de rangos (para el hueco común de varias pantallas). */
export function unionRanges(lists: OccupiedRange[][]): OccupiedRange[] {
  return lists.flat();
}
