// SSOT de fechas UTC (issue #8 P2).
// startOfDayUTC vivía duplicado en lib/dashboard.ts y lib/billing-status.ts.
// Un solo lugar; ambos lo importan.
export function startOfDayUTC(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
