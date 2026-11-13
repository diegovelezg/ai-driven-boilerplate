// Espacios vendibles por pantalla y día (1 slot = 1 espacio).
// Puro (sin server-only): testeable desde tests/ y reusable en cliente.
export const DEFAULT_SLOTS_PER_SCREEN = 10;

/** Normaliza el valor de BD a entero 1..100 (fail-closed al default). */
export function normalizeSlotsPerScreen(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) return DEFAULT_SLOTS_PER_SCREEN;
  return n;
}
