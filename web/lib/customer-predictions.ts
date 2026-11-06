// Presentación de predicciones del motor (lectura). Módulo puro sin imports
// server: apto para Client Components (no importar customers-db aquí,
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

/** Muestra etiquetada para calibrar el corte: p del motor + si el cliente
 *  volvió a comprar dentro de su ventana tras la predicción. */
export interface CloseWatchSample {
  p: number;
  returned: boolean;
}

/** Mínimo de historia para fitear (menos = se conserva el default). */
export const CLOSE_WATCH_FIT_MIN_SAMPLES = 30;
/** Mínimo de casos por clase (sin positivos y negativos no hay corte). */
export const CLOSE_WATCH_FIT_MIN_PER_CLASS = 5;
/** Guardarraíles anti-degenerado del corte fiteado (no son negocio: evitan
 *  "nadie es cercano" o "todos son cercanos" con historia rala). */
export const CLOSE_WATCH_FIT_MIN_P = 0.02;
export const CLOSE_WATCH_FIT_MAX_P = 0.5;

/**
 * Corte p aprendido del tenant para "seguimiento cercano" (autocalibración,
 * sin hardcodear por tienda). Criterio: J de Youden (sensibilidad +
 * especificidad − 1) sobre la historia etiquetada — el corte que mejor
 * separa a los que volvieron de los que no. Empate → corte menor (favorece
 * cobertura). Devuelve null si p no discrimina (J ≤ 0) o hay poca historia:
 * el llamador conserva el default.
 */
export function fitCloseWatchP(samples: CloseWatchSample[]): number | null {
  const rows = samples.filter(
    (s) => Number.isFinite(s.p) && s.p >= 0 && s.p <= 1,
  );
  if (rows.length < CLOSE_WATCH_FIT_MIN_SAMPLES) return null;
  const pos = rows.filter((s) => s.returned).length;
  const neg = rows.length - pos;
  if (pos < CLOSE_WATCH_FIT_MIN_PER_CLASS || neg < CLOSE_WATCH_FIT_MIN_PER_CLASS) return null;
  const candidates = [...new Set(rows.map((s) => s.p))].sort((a, b) => a - b);
  let best: number | null = null;
  let bestJ = 0;
  for (const c of candidates) {
    const tp = rows.filter((s) => s.returned && s.p >= c).length;
    const fp = rows.filter((s) => !s.returned && s.p >= c).length;
    const j = tp / pos + (neg - fp) / neg - 1;
    if (j > bestJ + 1e-9) {
      bestJ = j;
      best = c;
    }
  }
  if (best === null) return null;
  const clamped = Math.min(CLOSE_WATCH_FIT_MAX_P, Math.max(CLOSE_WATCH_FIT_MIN_P, best));
  return Math.round(clamped * 100) / 100;
}
