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
  /** p(horizonte) del motor (null = foto sin la columna). */
  pRecompraH: number | null;
  valorEsperadoMinor: number | null;
  /** Ejes de segmentación (issue #14A): null = foto anterior a la migración. */
  ritmo: string | null;
  ventana: string | null;
  bandaP: string | null;
  valorDecil: number | null;
  elegibilidad: string | null;
}

export const RITMO_VALUES = new Set<string>(["con-ritmo", "primera", "sin-compras"]);
export const VENTANA_VALUES = new Set<string>(["antes", "en", "pasada", "dormido"]);
export const BANDA_VALUES = new Set<string>(["organico-probable", "recuperable", "lejos"]);
export const ELEGIBILIDAD_VALUES = new Set<string>(["ok", "sin-canal", "contacto-reciente"]);
/** Tiers de decil de valor (1-10 intra-tienda-moneda). */
export const DECIL_VALUES = new Set<string>(["alto", "medio", "bajo"]);

export function matchesDecilFilter(decil: number | null, filter: string): boolean {
  if (decil == null) return false;
  if (filter === "alto") return decil >= 8;
  if (filter === "medio") return decil >= 4 && decil <= 7;
  if (filter === "bajo") return decil <= 3;
  return false;
}

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

/** Corte default de "seguimiento cercano" (issue #21 Paso 1): p>=0.10.
 *  Documentado, no fitted: valor observado en la referencia, overridable
 *  por tenant vía `store_profiles.close_watch_p`. Solo display. */
export const CLOSE_WATCH_DEFAULT_P = 0.1;

/** ¿Es seguimiento cercano? decision==vigilar AND (banda recuperable OR p>=corte).
 *  Solo display: nunca cambia `decision`. */
export function isCloseWatch(
  pred:
    | { decision: string; bandaP: string | null; pRecompraH: number | null }
    | undefined,
  cutoff: number = CLOSE_WATCH_DEFAULT_P,
): boolean {
  if (!pred || pred.decision !== "vigilar") return false;
  if (pred.bandaP === "recuperable") return true;
  const p = pred.pRecompraH;
  return p !== null && Number.isFinite(p) && (p as number) >= cutoff;
}
