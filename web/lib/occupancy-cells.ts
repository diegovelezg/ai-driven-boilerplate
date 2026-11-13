// Estado visual de una celda día-pantalla (matriz de ocupación).
// Fracción vendida del día: 0 (libre), 1–79% (bajo), 80–99% (alto),
// 100% (lleno), >100% (sobreventa legacy). Puro y testeable.
export type DayCellState = "free" | "low" | "high" | "full" | "over";

export function dayCellState(taken: number, capacity: number): DayCellState {
  if (!Number.isFinite(taken) || taken <= 0) return "free";
  if (!Number.isFinite(capacity) || capacity <= 0) return "full";
  if (taken > capacity) return "over";
  const pct = taken / capacity;
  if (pct >= 1) return "full";
  if (pct >= 0.8) return "high";
  return "low";
}
