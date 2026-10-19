// Issue #19: trazabilidad de acciones — helpers puros (sin DB ni LLM).
// Semántica única para Dashboard (Últimos enviados) y ficha (Contactos):
// la ventana es la del analyst (H por arquetipo) y `revenue_attributed`
// null con ventana abierta NUNCA es "no volvió".

export type DispatchedOutcome =
  | { kind: "volvio"; revenue: number }
  | { kind: "en_ventana"; daysLeft: number }
  | { kind: "no_volvio" };

const DAY_MS = 86_400_000;

export function dispatchedOutcome(input: {
  dispatchedAt: string | null;
  revenueAttributed: number | null;
  windowDays: number;
  nowMs: number;
}): DispatchedOutcome | null {
  if (!input.dispatchedAt) return null;
  const sent = Date.parse(input.dispatchedAt);
  if (Number.isNaN(sent)) return null;
  if (input.revenueAttributed != null && input.revenueAttributed > 0) {
    return { kind: "volvio", revenue: input.revenueAttributed };
  }
  const windowEnd = sent + Math.max(0, input.windowDays) * DAY_MS;
  if (input.nowMs <= windowEnd) {
    return {
      kind: "en_ventana",
      daysLeft: Math.max(0, Math.ceil((windowEnd - input.nowMs) / DAY_MS)),
    };
  }
  return { kind: "no_volvio" };
}

/** Aprobaciones previas a la migración quedan sin registro: nunca inventar. */
export function approverLabel(approvedBy: string | null | undefined): string {
  const v = (approvedBy ?? "").trim();
  return v ? v : "sin registro";
}
