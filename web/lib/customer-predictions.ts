// Presentación de predicciones del motor (lectura). Módulo puro sin imports
// server: apto para Client Components (no importar customers-db/sync aquí,
// su cadena trae `server-only` y rompe el build del Pages/SSR).
// Lo pesado con BD (getPredictionsMap) vive en `lib/customers-db.ts`.
import { formatNumber } from "@/lib/format";

/** Predicción mínima para columnas/filtros (foto del día, solo lectura). */
export interface CustomerPredictionLite {
  decision: string;
  /** renovacion|segunda_compra (null = sin predicción). */
  model: string | null;
  tDays: number | null;
  p25Days: number | null;
  p75Days: number | null;
  valorEsperadoMinor: number | null;
}

export const RITMO_VALUES = new Set<string>(["con-ritmo", "primera", "sin-compras"]);

/** ¿La predicción calza con el filtro `decision`? Sin predicción no calza. */
export function matchesDecisionFilter(
  pred: CustomerPredictionLite | undefined,
  filter: string,
): boolean {
  if (!pred) return false;
  const d = pred.decision;
  if (filter === "actuar") return d === "actuar" || d === "revision_humana";
  if (filter === "no-tocar")
    return d === "organico" || d === "dormido" || d === "sin_canal" || d === "contactado_reciente";
  return d === filter;
}

/** Etiqueta de ventana desde t y p25/p75 (solo lectura, sin prometer efecto). */
export function ventanaLabel(pred: CustomerPredictionLite | undefined): string {
  if (!pred || pred.tDays === null || pred.p25Days === null) return "—";
  if (pred.p75Days !== null && pred.tDays > pred.p75Days)
    return `pasó hace ${formatNumber(pred.tDays - pred.p75Days)}d`;
  if (pred.tDays >= pred.p25Days) return "en ventana";
  return `entra en ${formatNumber(Math.max(0, Math.ceil(pred.p25Days - pred.tDays)))}d`;
}
