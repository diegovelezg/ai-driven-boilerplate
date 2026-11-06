// Motor probabilístico de recompra para pocos datos (multitenant).
// Núcleo puro TypeScript: sin Supabase ni red, determinista y testeable.
// Modelo A (renovación, F>=2): LogNormal con grilla bayesiana + censura.
// Modelo B (segunda compra, F=1): cohorte de la tienda, misma grilla.
// Ver issue #5 para el diseño completo.

export interface SessionInput {
  at: number;
  ticketMinor: number;
  currency: string | null;
}

export interface CustomerSessions {
  customerId: string;
  sessions: SessionInput[];
  /** Market asignado por el caller (partición, issue #21 Paso 3). Null = legacy. */
  marketId?: string | null;
  /** Tipo efectivo por cliente (manual_edits.customer_type ?? customer_type,
   *  issue #21 Paso 4). Null = fallback a `isB2B` global del input. */
  customerType?: string | null;
}

export type Decision =
  | "actuar"
  | "vigilar"
  | "organico"
  | "dormido"
  | "sin_canal"
  | "contactado_reciente"
  | "revision_humana";

export interface Prediction {
  customerId: string;
  model: "renovacion" | "segunda_compra";
  pRecompraH: number;
  pLow: number;
  pHigh: number;
  expectedDays: number | null;
  p25Days: number | null;
  p75Days: number | null;
  ticketEsperadoMinor: number | null;
  valorEsperadoMinor: number | null;
  decision: Decision;
  confidence: "alta" | "media" | "baja";
  /** Ejes de segmentación (issue #14A): decision es función pura de ellos. */
  ritmo: "con-ritmo" | "primera";
  ventana: "antes" | "en" | "pasada" | "dormido";
  bandaP: "organico-probable" | "recuperable" | "lejos";
  valorDecil: number | null;
  elegibilidad: "ok" | "sin-canal" | "contacto-reciente";
  decisionVersion: string;
  /** Partición que produjo la predicción (issue #21 Paso 3). Null = legacy. */
  marketId: string | null;
}

/** Versión de la función de decisión (auditable, re-ejecutable).
 *  v4:nodormido-exception = v3:market sin la excepción dormido→
 *  revision_humana para top B2B (el dormido con ventana lejana no abre
 *  señal: se lo espera, no se lo contacta). Con defaults reproduce v3
 *  salvo en ese caso. */
export const DECISION_VERSION = "v4:nodormido-exception";

/** Cortes default de banda_p (issue #21 Paso 5): reproducen v2.
 *  La forma es global; los valores son por tenant (store_profiles). */
export const BAND_HIGH_DEFAULT = 0.6;
export const BAND_LOW_DEFAULT = 0.15;

/** Ejes de entrada de la decisión (testeable sin modelo). */
export interface DecisionAxes {
  ritmo: Prediction["ritmo"];
  ventana: Prediction["ventana"];
  bandaP: Prediction["bandaP"];
  valorDecil: number | null;
  elegibilidad: Prediction["elegibilidad"];
}

/** decision = función pura y versionada de los ejes (issue #14A).
 *  Reglas (mismas que el bloque inline anterior, ahora auditables):
 *  elegibilidad manda (sin-canal/contacto-reciente) → organico-probable
 *  en ventana temprana es organico → dormido siempre (sin excepción:
 *  una cuenta dormida con ventana lejana no abre señal aunque sea top,
 *  se la espera, no se la quema) → recuperable en ventana con
 *  confianza e intervalo acotados es actuar → resto vigilar. */
export function decideFromAxes(
  axes: DecisionAxes,
  opts: {
    isB2B: boolean;
    confidence: Prediction["confidence"];
    ventanaAcotada: boolean;
    intervaloAncho: boolean;
    topDecil: boolean;
  },
): Decision {
  if (axes.elegibilidad === "sin-canal") return "sin_canal";
  if (axes.elegibilidad === "contacto-reciente") return "contactado_reciente";
  if (axes.bandaP === "organico-probable" && axes.ventana === "antes") return "organico";
  // Dormido no abre señal para nadie: ni top ni B2B. La ventana lejana
  // se espera (vigilar/dormido la cierra el scout); cuando t se acerque
  // a p25 la ventana deja de ser dormido y el flujo normal decide.
  // `isB2B`/`topDecil` quedan en la firma por compatibilidad (otros
  // callers los pasan) pero ya no cambian la decisión aquí.
  void opts.isB2B;
  void opts.topDecil;
  if (axes.ventana === "dormido") {
    return "dormido";
  }
  if (axes.bandaP !== "lejos" && axes.ventana !== "antes") {
    if (!opts.ventanaAcotada || opts.confidence === "baja" || opts.intervaloAncho) {
      return "vigilar";
    }
    return "actuar";
  }
  return "vigilar";
}

export interface StoreModelInput {
  asOf: number; // epoch ms; NUNCA Date.now() interno: se recibe
  cycleDays: number; // ciclo efectivo ya resuelto por el caller
  horizonDays: number; // H de la tabla de arquetipos
  sigma0: number;
  shopCurrency: string | null;
  customers: CustomerSessions[];
  // supresiones ya resueltas por el caller, para mantener esto puro:
  suppressed: Map<string, "sin_canal" | "contactado_reciente">;
  /** Opcional: true si el tenant es B2B (b2b_proyecto/b2b_recurrente).
   *  Legacy (issue #21 Paso 4): solo fallback cuando el cliente no trae
   *  `customerType`. Desde v4 ya no hay excepción dormido→revision_humana:
   *  el dormido no abre señal para ningún lado. */
  isB2B?: boolean;
  /** Etiqueta de la partición (issue #21 Paso 3). Se propaga a Prediction. */
  marketId?: string | null;
  /** Cortes de banda_p por tenant (issue #21 Paso 5). Null/inválido ⇒
   *  defaults 0.6/0.15 (reproducen v2). Calibración intacta. */
  bandHigh?: number | null;
  bandLow?: number | null;
  /** Ventana de episodización por tenant en días (issue #27 Pasos 1+3).
   *  El núcleo la normaliza vía `asValidEpisodeWindowDays` (finita en
   *  (1,60]; lo demás ⇒ sin fusión temporal = legacy). La fuente validada
   *  es `validateModelParams` (rechaza >60 a legacy completo). */
  episodeGapDays?: number | null;
  /** K máximo de la mezcla de ritmos (issue #27 Paso 2). Null/inválido/<2
   *  ⇒ legacy: grilla única (idéntico a v2). Entero ≥2 habilita la
   *  selección de K por BIC con guardarraíles (K≤4); si el K elegido es 1
   *  se usa el camino legacy exacto. La aplicación en producción la arbitra
   *  el tune con backtest (Paso 4); el default es no mezclar. */
  mixtureMaxK?: number | null;
  /** Fits aprendidos por el tune y persistidos por tenant (issue #27 Paso 3):
   *  mezcla efectiva por nivel, estable entre tunes (la predicción diaria NO
   *  reajusta). Validados en uso (fail-open ⇒ se ignoran si inválidos);
   *  preceden al ajuste EM al vuelo. K=1 ⇒ camino legacy exacto. */
  mixtureStoreFit?: MixtureLike | null;
  mixtureCohortFit?: MixtureLike | null;
  /** Out-param opcional: el caller lo pasa para volcar K/pesos/resp a
   *  `evidence_json` sin cambiar el contrato `Prediction`. */
  mixtureEvidence?: MixtureEvidence;
}

export const HORIZON_BY_ARCHETYPE: Record<string, number> = {
  b2c_consumible: 30,
  b2c_moda: 90,
  b2c_durable: 90,
  b2b_recurrente: 45,
  b2b_proyecto: 90,
  hibrido: 60,
};

export const SIGMA0_BY_ARCHETYPE: Record<string, number> = {
  b2c_consumible: 0.5,
  b2c_moda: 0.9,
  b2c_durable: 0.9,
  b2b_recurrente: 0.5,
  b2b_proyecto: 0.9,
  hibrido: 0.7,
};

const DAY_MS = 86_400_000;
const SQRT2 = Math.SQRT2;

/** erf(x) — aproximación Abramowitz & Stegun 7.1.26 (|error| ≤ 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function logNormalCdf(x: number, mu: number, sigma: number): number {
  if (x <= 0 || sigma <= 0) return 0;
  const z = (Math.log(x) - mu) / (sigma * SQRT2);
  const c = 0.5 * (1 + erf(z));
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
}

function logNormalLogPdf(x: number, mu: number, sigma: number): number {
  if (x <= 0 || sigma <= 0) return Number.NEGATIVE_INFINITY;
  const lnx = Math.log(x);
  const d = (lnx - mu) / sigma;
  return -Math.log(x) - Math.log(sigma) - 0.5 * Math.log(2 * Math.PI) - 0.5 * d * d;
}

interface GridCell {
  mu: number;
  sigma: number;
  w: number;
}

function muGrid(): number[] {
  const out: number[] = [];
  const lo = Math.log(3);
  const hi = Math.log(720);
  for (let m = lo; m <= hi + 1e-9; m += 0.05) out.push(m);
  return out;
}

function sigmaGrid(step = 0.05): number[] {
  const out: number[] = [];
  for (let s = 0.25; s <= 1.4 + 1e-9; s += step) {
    // Redondeo para evitar deriva flotante en la grilla.
    out.push(Math.round(s * 100) / 100);
  }
  return out;
}

const MU_VALS = muGrid();
const SIGMA_VALS = sigmaGrid();
const SIGMA_COARSE = sigmaGrid(0.1);

/**
 * Grilla bayesiana determinista (log-espacio).
 * prior mu ~ Normal(priorMu, priorSigmaMu); prior sigma ~ Normal(sigma0, 0.3)
 * evaluado en la grilla (issue #10 P2: sigma0 operativo, antes uniforme).
 * likelihood = prod pdf(gaps) * prod S(censurados).
 */
function fitGrid(
  gapsCompletados: number[],
  censurados: number[],
  priorMu: number,
  priorSigmaMu: number,
  sigma0 = 0.7,
  sigmaVals: number[] = SIGMA_VALS,
): GridCell[] {
  const cells: GridCell[] = [];
  const logW: number[] = [];
  const inv2v = 1 / (2 * priorSigmaMu * priorSigmaMu);
  const sigmaSd = 0.3;
  const inv2vs = 1 / (2 * sigmaSd * sigmaSd);
  let maxLog = Number.NEGATIVE_INFINITY;
  for (const mu of MU_VALS) {
    const dmu = mu - priorMu;
    const logPriorMu = -dmu * dmu * inv2v;
    for (const sigma of sigmaVals) {
      const ds = sigma - sigma0;
      const logPriorSigma = -ds * ds * inv2vs;
      let ll = logPriorMu + logPriorSigma;
      let bad = false;
      for (const g of gapsCompletados) {
        if (g <= 0) continue;
        const lp = logNormalLogPdf(g, mu, sigma);
        if (!Number.isFinite(lp)) {
          bad = true;
          break;
        }
        ll += lp;
      }
      if (bad) {
        logW.push(Number.NEGATIVE_INFINITY);
        cells.push({ mu, sigma, w: 0 });
        continue;
      }
      for (const c of censurados) {
        const t = Math.max(0, c);
        // S(0)=1 → logS=0, sin costo.
        if (t <= 0) continue;
        const cdf = logNormalCdf(t, mu, sigma);
        const s = 1 - cdf;
        if (s <= 0) {
          ll += Math.log(1e-300);
        } else {
          ll += Math.log(s);
        }
      }
      logW.push(ll);
      cells.push({ mu, sigma, w: 0 });
      if (ll > maxLog) maxLog = ll;
    }
  }
  // Normalizar en log-espacio.
  let total = 0;
  for (let i = 0; i < cells.length; i += 1) {
    const lw = logW[i];
    const w = Number.isFinite(lw) ? Math.exp(lw - maxLog) : 0;
    cells[i].w = w;
    total += w;
  }
  if (total <= 0 || !Number.isFinite(total)) {
    const u = 1 / cells.length;
    for (const c of cells) c.w = u;
    return cells;
  }
  for (const c of cells) c.w /= total;
  // Poda de celdas insignificantes (rendimiento, issue #5): el posterior
  // LogNormal es picudo; celdas con w<1e-4 no mueven p ni cuantiles pero
  // cuestan ~2600 CDFs por iteración de bisección. Podar + renormalizar.
  let kept = 0;
  for (const c of cells) {
    if (c.w < 1e-4) c.w = 0;
    else kept += 1;
  }
  if (kept === 0) {
    const u = 1 / cells.length;
    for (const c of cells) c.w = u;
    return cells;
  }
  let total2 = 0;
  for (const c of cells) total2 += c.w;
  for (const c of cells) c.w /= total2;
  return cells;
}

/** Media posterior de mu de una grilla (para shrinkage jerárquico). */
function gridMuMean(grid: GridCell[]): number {
  let m = 0;
  for (const c of grid) m += c.w * c.mu;
  return m;
}

/** Posterior del cliente con shrinkage jerárquico real (issue #10 P1-2).
 *  Diseño: el posterior de tienda NO se usa como prior multiplicativo
 *  (eso era doble conteo: datos del cliente ×2, tienda grande ⇒ cliente
 *  no se aparta, tienda chica ⇒ intervalos angostos al revés).
 *  En su lugar: prior paramétrico Normal(storeMu, sqrt(priorSigmaMu²+tau²))
 *  × prior sigma centrado en sigma0, evaluado solo con los datos del
 *  cliente (una sola vez). tau=0.4 = dispersión entre clientes
 *  (documentado, fijo Día 1; se recalibra con datos en el Paso 5 de #5).
 *  Efecto: tienda grande ⇒ el atípico sí se aparta; tienda chica ⇒
 *  intervalos más anchos (el prior pesa menos que un posterior angosto). */
function fitClientGrid(
  storeMu: number,
  priorSigmaMu: number,
  sigma0: number,
  gaps: number[],
  censoredT: number,
): GridCell[] {
  const tau = 0.4;
  const sd = Math.sqrt(priorSigmaMu * priorSigmaMu + tau * tau);
  // Grilla sigma gruesa en el nivel cliente (rendimiento): el posterior del
  // cliente con 0-4 gaps no resuelve sigma a 0.05; la tienda/cohorte usan la
  // grilla fina. Reduce celdas ~50% (≈1320 vs 2640).
  return fitGrid(gaps, censoredT > 0 ? [censoredT] : [], storeMu, sd, sigma0, SIGMA_COARSE);
}

interface GridPrediction {
  pMean: number;
  pLow: number;
  pHigh: number;
  sT: number;
  expDays: number | null;
  p25: number | null;
  p75: number | null;
}

function predictiveCdf(x: number, grid: GridCell[]): number {
  if (x <= 0) return 0;
  let acc = 0;
  for (const c of grid) {
    if (c.w < 1e-12) continue;
    acc += c.w * logNormalCdf(x, c.mu, c.sigma);
  }
  return Math.min(1, Math.max(0, acc));
}

/** Cuantil CONDICIONAL (issue #10 P1-1): F⁻¹(F(t) + q·S(t)).
 *  El cuantil incondicional podía caer en el pasado (t=100 → p25=40d).
 *  El condicional nunca es < t (salvo t=0) y es coherente con pRecompraH.
 *  Si S(t)≈0 (ya debería haber vuelto con certeza), retorna null. */
function predictiveQuantile(q: number, grid: GridCell[], t = 0): number | null {
  const tt = Math.max(0, t);
  if (tt <= 0) {
    // Sin censura: cuantil incondicional clásico.
    const hi0 = 3000;
    if (predictiveCdf(hi0, grid) < q) return null;
    let lo = 0.5;
    let hi = hi0;
    for (let i = 0; i < 16; i += 1) {
      const mid = (lo + hi) / 2;
      if (predictiveCdf(mid, grid) < q) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  const fT = predictiveCdf(tt, grid);
  const sT = 1 - fT;
  if (sT <= 1e-9) return null;
  const target = fT + q * sT;
  if (target >= 1) return null;
  // Búsqueda binaria en [t, t+3000]: F_mix monótona. 32 iteraciones bastan
  // para precisión <1 día en ventana de 3000d (3000/2^32 ≪ 1).
  let lo = tt;
  let hi = tt + 3000;
  if (predictiveCdf(hi, grid) < target) return null;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (predictiveCdf(mid, grid) < target) lo = mid;
    else hi = mid;
  }
  return Math.max(tt, (lo + hi) / 2);
}

function predictFromGrid(
  grid: GridCell[],
  t: number,
  H: number,
  cureProb = 0,
): GridPrediction {
  const tt = Math.max(0, t);
  const pi = Math.min(0.8, Math.max(0, cureProb));
  const pCells: Array<{ p: number; w: number }> = [];
  let pMean = 0;
  for (const c of grid) {
    if (c.w < 1e-12) {
      continue;
    }
    const ft = tt <= 0 ? 0 : logNormalCdf(tt, c.mu, c.sigma);
    const fth = logNormalCdf(tt + H, c.mu, c.sigma);
    const st = 1 - ft;
    // Mezcla cura (issue #10 P1-3): S_mix = π + (1-π)·S.
    // P(vuelve en H | sobrevive t) = (1-π)(F(t+H)-F(t)) / (π + (1-π)S(t)).
    const sMix = pi + (1 - pi) * st;
    let p = 0;
    if (sMix > 1e-12) p = ((1 - pi) * (fth - ft)) / sMix;
    else p = 0;
    if (!Number.isFinite(p)) p = 0;
    p = Math.min(1, Math.max(0, p));
    pCells.push({ p, w: c.w });
    pMean += c.w * p;
  }
  pMean = Math.min(1, Math.max(0, pMean));
  // Percentiles 10/90 ponderados sobre p por celda (incertidumbre
  // paramétrica pura: NO se fuerzan a contener la media — forzarlos
  // enmascaraba miscalibración, issue #10 P2).
  pCells.sort((a, b) => a.p - b.p);
  let acc = 0;
  let pLow = pCells.length > 0 ? pCells[0].p : 0;
  let pHigh = pCells.length > 0 ? pCells[pCells.length - 1].p : 0;
  let foundLow = false;
  for (const c of pCells) {
    acc += c.w;
    if (!foundLow && acc >= 0.1) {
      pLow = c.p;
      foundLow = true;
    }
    if (acc >= 0.9) {
      pHigh = c.p;
      break;
    }
  }
  // S(t) de la mezcla para dormido/churn (ver predictStore).
  const sLognormal = 1 - predictiveCdf(tt, grid);
  const sT = pi + (1 - pi) * sLognormal;
  // Cuantiles condicionales (issue #10 P1-1): tiempo DESDE la última
  // sesión, coherente con t (nunca < t salvo t=0). expectedDays = mediana
  // condicional (documentado: no es esperanza ni tiempo restante neto,
  // es el cuantil 50 de T_next | T_next > t medido desde la última compra).
  const q25 = predictiveQuantile(0.25, grid, tt);
  const q50 = predictiveQuantile(0.5, grid, tt);
  const q75 = predictiveQuantile(0.75, grid, tt);
  const clampQ = (q: number | null): number | null => {
    if (q === null) return null;
    // Coherencia con t (redondeo puede dar t-1): nunca por debajo de t.
    const v = Math.max(tt, q);
    return Math.max(1, Math.round(v));
  };
  return {
    pMean,
    pLow,
    pHigh,
    sT: Math.min(1, Math.max(0, sT)),
    expDays: clampQ(q50),
    p25: clampQ(q25),
    p75: clampQ(q75),
  };
}

/** Bisección de cuantil condicional con CDF arbitraria (issue #27 Paso 2).
 *  Extraído de `predictiveQuantile` sin cambiar su matemática: F monótona,
 *  búsqueda en [t, t+3000], 16 iteraciones, null si S(t)≈0 o no alcanza. */
function quantileFromCdf(q: number, t: number, cdf: (x: number) => number): number | null {
  const tt = Math.max(0, t);
  if (tt <= 0) {
    const hi0 = 3000;
    if (cdf(hi0) < q) return null;
    let lo = 0.5;
    let hi = hi0;
    for (let i = 0; i < 16; i += 1) {
      const mid = (lo + hi) / 2;
      if (cdf(mid) < q) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  const fT = cdf(tt);
  const sT = 1 - fT;
  if (sT <= 1e-9) return null;
  const target = fT + q * sT;
  if (target >= 1) return null;
  let lo = tt;
  let hi = tt + 3000;
  if (cdf(hi) < target) return null;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < target) lo = mid;
    else hi = mid;
  }
  return Math.max(tt, (lo + hi) / 2);
}

/** Mezcla de K ritmos (issue #27 Paso 2): K familias LogNormal sobre
 *  tiempos entre episodios, con censura. Es la evolución de la grilla
 *  única (1 familia → K familias, K∈[1..4]); K=1 equivale en espíritu al
 *  modelo actual. Todo puro/determinista: el ajuste EM es por partición
 *  (tienda/cohorte), nunca por cliente; por cliente solo se evalúan K
 *  CDFs (pertenencia blanda). NO es K-Means: pertenencia blanda, forma
 *  LogNormal por componente y la censura ("aún no volvió") entra como
 *  supervivencia en E-step, pesos y BIC. La M-step estima (μ,σ) en forma
 *  cerrada sobre gaps completados; los censurados pesan en E-step
 *  (asignación), pesos y verosimilitud total (documentado: MLE censurado
 *  completo queda para el tune con más n; con ~100 repetidores el punto
 *  justo es este). */
export const MIXTURE_VERSION = "mix1:lognormal-em";
export const MIXTURE_MAX_K = 4;
/** Guardarraíles de tamaño (issue #27 Paso 2): por componente, lo mayor
 *  entre N absoluto y fracción de la base. Por debajo ⇒ ese K no existe. */
const MIXTURE_MIN_COMPONENT_N = 15;
const MIXTURE_MIN_COMPONENT_FRAC = 0.1;
/** Cotas operativas de componentes (issue #27 Paso 3): espejan la grilla
 *  del núcleo (σ∈[0.25,1.4]) y el techo de ciclo del tenant (μ≤ln(1095),
 *  μ≥ln(1): un ritmo mediano sub-diario no es un episodio). El lector las
 *  exige (fail-open a legacy); el EM ya las produce por construcción. */
export const MIXTURE_MU_MIN = 0;
export const MIXTURE_MU_MAX = Math.log(1095);
export const MIXTURE_SIGMA_MIN = 0.25;
export const MIXTURE_SIGMA_MAX = 1.4;

export interface MixtureComponent {
  weight: number;
  mu: number;
  sigma: number;
}

/** Mezcla utilizable para predecir: K + componentes. `MixtureFit` (salida
 *  del EM con BIC/n/masa) la extiende; los fits aprendidos por el tune
 *  (Paso 3/4, persistidos sin BIC) entran por aquí. */
export interface MixtureLike {
  k: number;
  components: MixtureComponent[];
}

export interface MixtureFit extends MixtureLike {
  bic: number;
  logLik: number;
  n: number;
  /** Masa blanda por componente (Σ responsabilidades), para guardarraíles. */
  mass: number[];
}

/** Valida una mezcla externa (p. ej. aprendida por el tune, issue #27 Paso 3).
 *  Estricta en forma (k entero 1..4, N componentes, pesos finitos >0 con suma
 *  ≈1) y en rango operativo (μ∈[ln1,ln1095], σ∈[0.25,1.4]: fuera de eso es
 *  basura persistida, no un ritmo); ordena la copia por μ. Null ⇒ el caller
 *  usa legacy/EM (fail-open). Pura. */
export function asValidMixtureFit(raw: unknown): MixtureLike | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const k = r.k;
  const comps = r.components;
  if (!Number.isInteger(k) || (k as number) < 1 || (k as number) > MIXTURE_MAX_K) return null;
  if (!Array.isArray(comps) || comps.length !== k) return null;
  const parsed: MixtureComponent[] = [];
  let sum = 0;
  for (const c of comps) {
    if (typeof c !== "object" || c === null) return null;
    const cc = c as Record<string, unknown>;
    if (
      typeof cc.weight !== "number" || !Number.isFinite(cc.weight) || cc.weight <= 0 ||
      typeof cc.mu !== "number" || !Number.isFinite(cc.mu) ||
      cc.mu < MIXTURE_MU_MIN || cc.mu > MIXTURE_MU_MAX ||
      typeof cc.sigma !== "number" || !Number.isFinite(cc.sigma) ||
      cc.sigma < MIXTURE_SIGMA_MIN || cc.sigma > MIXTURE_SIGMA_MAX
    ) {
      return null;
    }
    sum += cc.weight as number;
    parsed.push({ weight: cc.weight as number, mu: cc.mu as number, sigma: cc.sigma as number });
  }
  if (!(Math.abs(sum - 1) <= 1e-6)) return null;
  parsed.sort((a, b) => a.mu - b.mu);
  return { k: k as number, components: parsed };
}

/** Evidencia de mezcla por corrida (out-param de `predictStore`).
 *  El caller la vuelca a `evidence_json`; `Prediction` no cambia.
 *  El objeto es de un solo uso por llamada/partición: `predictStore` lo
 *  rellena entero (incluido un `respById` fresco) para no mezclar
 *  particiones si se reutiliza por error. */
export interface MixtureEvidence {
  store?: MixtureLike | null;
  cohort?: MixtureLike | null;
  respById?: Map<string, number[]>;
}

/** Ajusta K componentes LogNormal por EM determinista (issue #27 Paso 2).
 *  Init por cuantiles de ln(gaps) (determinista); null si k<1 o sin datos.
 *  Componentes ordenados por μ ascendente (ancla estable entre tunes). */
export function fitMixture(
  gapsCompletados: number[],
  censurados: number[],
  k: number,
  opts?: { priorMu?: number; sigma0?: number; maxIter?: number },
): MixtureFit | null {
  if (!Number.isInteger(k) || k < 1 || k > MIXTURE_MAX_K) return null;
  const gaps = gapsCompletados.filter((g) => g > 0);
  const cens = censurados.filter((t) => t > 0);
  const n = gaps.length + cens.length;
  if (n === 0) return null;
  const priorMu = typeof opts?.priorMu === "number" && Number.isFinite(opts.priorMu)
    ? opts.priorMu
    : Math.log(30);
  const sigma0 = typeof opts?.sigma0 === "number" && opts.sigma0 > 0 ? opts.sigma0 : 0.7;
  const maxIter = typeof opts?.maxIter === "number" && opts.maxIter > 0
    ? Math.min(200, Math.floor(opts.maxIter))
    : 50;
  const logGaps = gaps.map((g) => Math.log(g)).sort((a, b) => a - b);
  // Init determinista por cuantiles; sin gaps completados ⇒ prior.
  const comps: Array<{ w: number; mu: number; sigma: number }> = [];
  for (let c = 0; c < k; c += 1) {
    let mu = priorMu;
    if (logGaps.length > 0) {
      const lo = Math.floor((c * logGaps.length) / k);
      const hi = Math.max(lo + 1, Math.floor(((c + 1) * logGaps.length) / k));
      const slice = logGaps.slice(lo, hi);
      mu = slice.reduce((a, b) => a + b, 0) / slice.length;
    }
    comps.push({ w: 1 / k, mu, sigma: sigma0 });
  }
  // σ acotada al rango operativo (ver MIXTURE_SIGMA_MIN/MAX).
  const SIG_LO = MIXTURE_SIGMA_MIN;
  const SIG_HI = MIXTURE_SIGMA_MAX;
  let prevLl = Number.NEGATIVE_INFINITY;
  let mass = comps.map(() => 0);
  for (let iter = 0; iter < maxIter; iter += 1) {
    // E-step en log-espacio: completados ⇒ pdf; censurados ⇒ supervivencia.
    const respG: number[][] = gaps.map(() => new Array<number>(k).fill(0));
    const respC: number[][] = cens.map(() => new Array<number>(k).fill(0));
    let ll = 0;
    for (let i = 0; i < gaps.length; i += 1) {
      let mx = Number.NEGATIVE_INFINITY;
      const lr: number[] = new Array<number>(k);
      for (let c = 0; c < k; c += 1) {
        lr[c] = Math.log(Math.max(1e-300, comps[c].w)) + logNormalLogPdf(gaps[i], comps[c].mu, comps[c].sigma);
        if (lr[c] > mx) mx = lr[c];
      }
      let tot = 0;
      for (let c = 0; c < k; c += 1) {
        respG[i][c] = Math.exp(lr[c] - mx);
        tot += respG[i][c];
      }
      for (let c = 0; c < k; c += 1) respG[i][c] /= tot;
      ll += mx + Math.log(Math.max(1e-300, tot));
    }
    for (let i = 0; i < cens.length; i += 1) {
      let mx = Number.NEGATIVE_INFINITY;
      const lr: number[] = new Array<number>(k);
      for (let c = 0; c < k; c += 1) {
        const s = Math.max(1e-300, 1 - logNormalCdf(cens[i], comps[c].mu, comps[c].sigma));
        lr[c] = Math.log(Math.max(1e-300, comps[c].w)) + Math.log(s);
        if (lr[c] > mx) mx = lr[c];
      }
      let tot = 0;
      for (let c = 0; c < k; c += 1) {
        respC[i][c] = Math.exp(lr[c] - mx);
        tot += respC[i][c];
      }
      for (let c = 0; c < k; c += 1) respC[i][c] /= tot;
      ll += mx + Math.log(Math.max(1e-300, tot));
    }
    if (!Number.isFinite(ll)) return null;
    // M-step: pesos con toda la masa; (μ,σ) en forma cerrada sobre gaps.
    const Nk = new Array<number>(k).fill(0);
    for (const r of respG) for (let c = 0; c < k; c += 1) Nk[c] += r[c];
    for (const r of respC) for (let c = 0; c < k; c += 1) Nk[c] += r[c];
    mass = Nk;
    let alive = true;
    for (let c = 0; c < k; c += 1) {
      if (!(Nk[c] > 1e-9)) {
        alive = false;
        break;
      }
    }
    if (!alive) return null;
    for (let c = 0; c < k; c += 1) {
      comps[c].w = Nk[c] / n;
      let num = 0;
      let den = 0;
      for (let i = 0; i < gaps.length; i += 1) {
        num += respG[i][c] * Math.log(gaps[i]);
        den += respG[i][c];
      }
      if (den > 1e-9 && gaps.length > 0) {
        const mu = num / den;
        let v = 0;
        for (let i = 0; i < gaps.length; i += 1) {
          const d = Math.log(gaps[i]) - mu;
          v += respG[i][c] * d * d;
        }
        comps[c].mu = mu;
        comps[c].sigma = Math.min(SIG_HI, Math.max(SIG_LO, Math.sqrt(Math.max(1e-6, v / den))));
      }
    }
    if (Math.abs(ll - prevLl) < 1e-6 * Math.max(1, Math.abs(ll))) {
      prevLl = ll;
      break;
    }
    prevLl = ll;
  }
  // Ordenar por μ ascendente (ancla estable: el "grupo 2" no cambia de
  // significado entre tunes; la superficie habla de comportamiento).
  const order = comps.map((_, i) => i).sort((a, b) => comps[a].mu - comps[b].mu);
  const components: MixtureComponent[] = order.map((i) => ({
    weight: comps[i].w,
    mu: comps[i].mu,
    sigma: comps[i].sigma,
  }));
  const orderedMass = order.map((i) => mass[i]);
  // Verosimilitud total final con componentes ordenados.
  let logLik = 0;
  for (const g of gaps) {
    let tot = 0;
    for (const c of components) tot += c.weight * Math.exp(logNormalLogPdf(g, c.mu, c.sigma));
    logLik += Math.log(Math.max(1e-300, tot));
  }
  for (const t of cens) {
    let tot = 0;
    for (const c of components) tot += c.weight * Math.max(1e-300, 1 - logNormalCdf(t, c.mu, c.sigma));
    logLik += Math.log(Math.max(1e-300, tot));
  }
  if (!Number.isFinite(logLik)) return null;
  const nParams = 3 * k - 1;
  const bic = -2 * logLik + nParams * Math.log(Math.max(1, n));
  return { k, components, bic, logLik, n, mass: orderedMass };
}

/** Elige K por BIC con guardarraíles de tamaño (issue #27 Paso 2).
 *  Descarta K cuya masa mínima < max(MIN_N, MIN_FRAC·n); K=1 es válido
 *  con n≥1. Retorna null si ningún K es válido ⇒ el caller usa legacy. */
export function selectMixtureK(
  candidates: Array<MixtureFit | null>,
  opts?: { minComponentN?: number; minComponentFrac?: number },
): MixtureFit | null {
  const minN = typeof opts?.minComponentN === "number" && opts.minComponentN > 0
    ? opts.minComponentN
    : MIXTURE_MIN_COMPONENT_N;
  const minFrac = typeof opts?.minComponentFrac === "number" && opts.minComponentFrac >= 0
    ? opts.minComponentFrac
    : MIXTURE_MIN_COMPONENT_FRAC;
  let best: MixtureFit | null = null;
  for (const fit of candidates) {
    if (!fit || fit.n < 1) continue;
    const floor = Math.max(minN, minFrac * fit.n);
    const minMass = Math.min(...fit.mass);
    if (fit.k > 1 && !(minMass >= floor)) continue;
    if (best === null || fit.bic < best.bic) best = fit;
  }
  return best;
}

/** Pertenencia blanda del cliente (issue #27 Paso 2): posterior de cada
 *  componente ∝ peso × verosimilitud de sus gaps (pdf) y su t (supervivencia
 *  si t>0). Sin datos ⇒ prior (pesos). Suma 1. */
export function mixtureResponsibilities(
  gaps: number[],
  t: number,
  fit: MixtureLike,
): number[] {
  const k = fit.k;
  const lr: number[] = new Array<number>(k);
  for (let c = 0; c < k; c += 1) {
    const comp = fit.components[c];
    let l = Math.log(Math.max(1e-300, comp.weight));
    for (const g of gaps) {
      if (g <= 0) continue;
      l += logNormalLogPdf(g, comp.mu, comp.sigma);
    }
    if (t > 0) {
      l += Math.log(Math.max(1e-300, 1 - logNormalCdf(t, comp.mu, comp.sigma)));
    }
    lr[c] = l;
  }
  const mx = Math.max(...lr);
  const w = lr.map((v) => (Number.isFinite(v) ? Math.exp(v - mx) : 0));
  const tot = w.reduce((a, b) => a + b, 0);
  if (!(tot > 0)) return fit.components.map((c) => c.weight);
  return w.map((v) => v / tot);
}

function mixtureCdf(x: number, fit: MixtureLike, resp: number[]): number {
  if (x <= 0) return 0;
  let acc = 0;
  for (let c = 0; c < fit.k; c += 1) {
    acc += resp[c] * logNormalCdf(x, fit.components[c].mu, fit.components[c].sigma);
  }
  return Math.min(1, Math.max(0, acc));
}

/** p del cliente como mezcla (issue #27 Paso 2): Σ respₖ · pₖ con la misma
 *  fórmula de cura que `predictFromGrid` por componente puntual. pLow/pHigh
 *  = percentiles 10/90 ponderados por resp (misma regla que la grilla);
 *  cuantiles condicionales sobre la CDF mezcla; sT con cura para dormido. */
export function predictFromMixture(
  fit: MixtureLike,
  resp: number[],
  t: number,
  H: number,
  cureProb = 0,
): GridPrediction {
  const tt = Math.max(0, t);
  const pi = Math.min(0.8, Math.max(0, cureProb));
  const pCells: Array<{ p: number; w: number }> = [];
  let pMean = 0;
  for (let c = 0; c < fit.k; c += 1) {
    const comp = fit.components[c];
    const w = resp[c] ?? 0;
    if (!(w > 1e-12)) continue;
    const ft = tt <= 0 ? 0 : logNormalCdf(tt, comp.mu, comp.sigma);
    const fth = logNormalCdf(tt + H, comp.mu, comp.sigma);
    const st = 1 - ft;
    const sMix = pi + (1 - pi) * st;
    let p = 0;
    if (sMix > 1e-12) p = ((1 - pi) * (fth - ft)) / sMix;
    if (!Number.isFinite(p)) p = 0;
    p = Math.min(1, Math.max(0, p));
    pCells.push({ p, w });
    pMean += w * p;
  }
  pMean = Math.min(1, Math.max(0, pMean));
  pCells.sort((a, b) => a.p - b.p);
  let acc = 0;
  let pLow = pCells.length > 0 ? pCells[0].p : 0;
  let pHigh = pCells.length > 0 ? pCells[pCells.length - 1].p : 0;
  let foundLow = false;
  for (const c of pCells) {
    acc += c.w;
    if (!foundLow && acc >= 0.1) {
      pLow = c.p;
      foundLow = true;
    }
    if (acc >= 0.9) {
      pHigh = c.p;
      break;
    }
  }
  const cdf = (x: number): number => mixtureCdf(x, fit, resp);
  const sT = pi + (1 - pi) * (1 - cdf(tt));
  const clampQ = (q: number | null): number | null => {
    if (q === null) return null;
    const v = Math.max(tt, q);
    return Math.max(1, Math.round(v));
  };
  return {
    pMean,
    pLow,
    pHigh,
    sT: Math.min(1, Math.max(0, sT)),
    expDays: clampQ(quantileFromCdf(0.5, tt, cdf)),
    p25: clampQ(quantileFromCdf(0.25, tt, cdf)),
    p75: clampQ(quantileFromCdf(0.75, tt, cdf)),
  };
}

/**
 * Ordena ascendente y fusiona órdenes a <1 día en una sesión
 * (fecha = la primera, ticket = suma solo si misma moneda).
 * Gaps resultantes siempre ≥1 día.
 */
export function sessionize(
  orders: Array<{ placedAt: number; ticketMinor: number; currency: string | null }>,
): SessionInput[] {
  const sorted = [...orders].sort((a, b) => a.placedAt - b.placedAt);
  const out: SessionInput[] = [];
  for (const o of sorted) {
    if (!Number.isFinite(o.placedAt)) continue;
    const last = out[out.length - 1];
    if (last && o.placedAt - last.at < DAY_MS) {
      // Misma sesión: solo suma si misma moneda (insensible a mayúsculas;
      // null factura junto a null). Si difieren, la fecha cuenta pero el
      // ticket queda con el de la primera (regla monetaria intra-moneda).
      const a = (last.currency ?? "").toUpperCase();
      const b = (o.currency ?? "").toUpperCase();
      if (a === b) {
        last.ticketMinor += o.ticketMinor;
      }
      continue;
    }
    out.push({ at: o.placedAt, ticketMinor: o.ticketMinor, currency: o.currency ?? null });
  }
  return out;
}

/** Versión de episodización (auditable, issue #27 Paso 1). */
export const EPISODE_VERSION = "ep1:gap-keys";
/** Techo operativo de la ventana de episodio (issue #27 Paso 3): por encima
 *  se colapsa el ritmo recurrente real (F→1). El lector lo rechaza
 *  (fail-open a legacy); el tune además lo mueve con trust region. */
export const EPISODE_WINDOW_MAX_DAYS = 60;

/** Normaliza una ventana de episodio (puro, issue #27 review Pasos 1-3).
 *  Retorna días finitos en (1,60] o null (= legacy, sin fusión temporal).
 *  El núcleo se autodefiende aunque el caller no haya validado: una ventana
 *  absurda (>60) NO fusiona un año en un episodio, cae a legacy. */
export function asValidEpisodeWindowDays(windowDays: unknown): number | null {
  if (typeof windowDays !== "number" || !Number.isFinite(windowDays)) return null;
  if (windowDays <= 1 || windowDays > EPISODE_WINDOW_MAX_DAYS) return null;
  return windowDays;
}

/** Un episodio = 1+ sesiones fusionadas (ráfaga/campaña).
 *  startAt = primera sesión; endAt = última (fin del episodio, para `t`).
 *  En legacy (sin ventana válida) startAt === endAt === sesión.at. */
export interface Episode {
  startAt: number;
  endAt: number;
  ticketMinor: number;
  currency: string | null;
  sessionCount: number;
  windowKey: string | null;
}

/**
 * Agrupa sesiones en episodios de compra (issue #27 Paso 1, puro/testeable).
 * Fusiona conservadoramente si (a) brecha entre sesiones ≤ windowDays
 * (solo ventana válida vía `asValidEpisodeWindowDays`: finita en (1,60];
 * null/inválida/<=1/>60 ⇒ sin fusión temporal = comportamiento actual),
 * o (b) comparten `windowKeys` no nula
 * (misma ventana declarada del metadata map del tenant, p. ej. mismo
 * dateStart..dateEnd; agnóstica al contenido: el caller la resuelve).
 * `windowKeys` es paralela al array de entrada (pre-orden); se ordena junto
 * a las sesiones. Ordena ascendente, ignora `at` no finitos.
 */
export function episodeize(
  sessions: SessionInput[],
  windowDays?: number | null,
  windowKeys?: Array<string | null> | null,
): Episode[] {
  const pairs = sessions
    .map((s, i) => ({ s, k: windowKeys?.[i] ?? null }))
    .filter((p) => Number.isFinite(p.s.at))
    .sort((a, b) => a.s.at - b.s.at);
  const gapWindow = asValidEpisodeWindowDays(windowDays);
  const out: Episode[] = [];
  for (const { s, k } of pairs) {
    const key = typeof k === "string" && k.length > 0 ? k : null;
    const last = out[out.length - 1];
    if (last) {
      const gapDays = (s.at - last.endAt) / DAY_MS;
      const sameWindow = key !== null && last.windowKey !== null && key === last.windowKey;
      if (sameWindow || (gapWindow !== null && gapDays <= gapWindow)) {
        // Fusiona: fin avanza, ticket suma solo misma moneda (regla sesión),
        // sessionCount crece; la ventana solo se conserva si coincide en
        // ambas (misma key no nula); si la fusión fue solo temporal, la
        // ventana del episodio queda indeterminada (null, mixto).
        last.endAt = s.at;
        const a = (last.currency ?? "").toUpperCase();
        const b = (s.currency ?? "").toUpperCase();
        if (a === b) last.ticketMinor += s.ticketMinor;
        last.sessionCount += 1;
        if (!sameWindow) last.windowKey = null;
        continue;
      }
    }
    out.push({
      startAt: s.at,
      endAt: s.at,
      ticketMinor: s.ticketMinor,
      currency: s.currency ?? null,
      sessionCount: 1,
      windowKey: key,
    });
  }
  return out;
}

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round3(x: number): number {
  return Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
}

export function predictStore(input: StoreModelInput): Prediction[] {
  const cycle = input.cycleDays > 0 && Number.isFinite(input.cycleDays) ? input.cycleDays : 30;
  const H = input.horizonDays > 0 && Number.isFinite(input.horizonDays) ? input.horizonDays : 30;
  const priorMu0 = Math.log(Math.max(1, cycle));
  const priorSigmaMu = 0.35;
  // sigma0 operativo (issue #10 P2): centro del prior de sigma. Si el caller
  // no lo trae, se usa el neutro 0.7.
  const sigma0 =
    Number.isFinite(input.sigma0) && input.sigma0 > 0 ? input.sigma0 : 0.7;

  interface PerCustomer {
    id: string;
    sessions: SessionInput[];
    episodes: Episode[];
    gaps: number[];
    t: number;
    lastAt: number | null;
  }
  const per: PerCustomer[] = input.customers.map((c) => {
    const sessions = [...c.sessions].sort((a, b) => a.at - b.at);
    // Episodios (issue #27 Paso 1): sin ventana válida cada sesión es un
    // episodio (startAt=endAt=at) ⇒ gaps/t idénticos a v2. Con ventana >1
    // los gaps son entre episodios (siguiente.start - previo.end) y t desde
    // el fin del último episodio.
    const episodes = episodeize(sessions, input.episodeGapDays ?? null, null);
    const gaps: number[] = [];
    for (let i = 1; i < episodes.length; i += 1) {
      const g = (episodes[i].startAt - episodes[i - 1].endAt) / DAY_MS;
      if (g > 0) gaps.push(g);
    }
    const lastAt = episodes.length > 0 ? episodes[episodes.length - 1].endAt : null;
    const t = lastAt === null ? 0 : Math.max(0, (input.asOf - lastAt) / DAY_MS);
    return { id: c.customerId, sessions, episodes, gaps, t, lastAt };
  });

  // Grilla de tienda SOLO con F>=2 (issue #10 P1-3): los censurados F=1
  // (que mayormente jamás vuelven) contaminaban μ/σ de la prior de
  // renovación. El Modelo A aprende solo de renovadores reales.
  const storeGaps: number[] = [];
  const storeCens: number[] = [];
  for (const p of per) {
    if (p.episodes.length < 2) continue;
    for (const g of p.gaps) storeGaps.push(g);
    storeCens.push(p.t);
  }
  const storeGrid = fitGrid(storeGaps, storeCens, priorMu0, priorSigmaMu, sigma0);
  const storeMu = gridMuMean(storeGrid);

  // Cohorte F=1: tiempo hasta el 2º episodio (completado) o censura.
  const cohortGaps: number[] = [];
  const cohortCens: number[] = [];
  for (const p of per) {
    if (p.episodes.length === 0) continue;
    if (p.episodes.length >= 2) {
      const first = (p.episodes[1].startAt - p.episodes[0].endAt) / DAY_MS;
      if (first > 0) cohortGaps.push(first);
    } else {
      cohortCens.push(p.t);
    }
  }
  const cohortGrid = fitGrid(cohortGaps, cohortCens, priorMu0, priorSigmaMu, sigma0);

  // Mezcla de K ritmos (issue #27 Pasos 2-3): dos fuentes, orden fijo.
  // 1) Fits aprendidos por el tune y persistidos por tenant/partición
  //    (estables entre tunes: la predicción diaria NO reajusta).
  // 2) Ajuste EM al vuelo con selección de K por BIC (opt-in temporal).
  // Default (sin fits ni mixtureMaxK≥2) ⇒ legacy: grilla única exacta.
  const explicitStore = asValidMixtureFit(input.mixtureStoreFit ?? null);
  const explicitCohort = asValidMixtureFit(input.mixtureCohortFit ?? null);
  const mixtureK = typeof input.mixtureMaxK === "number" && Number.isFinite(input.mixtureMaxK)
    ? Math.min(MIXTURE_MAX_K, Math.max(1, Math.floor(input.mixtureMaxK)))
    : 1;
  let storeMixture: MixtureLike | null = explicitStore;
  let cohortMixture: MixtureLike | null = explicitCohort;
  if (mixtureK >= 2 && (storeMixture === null || cohortMixture === null)) {
    const storeCands: Array<MixtureFit | null> = [];
    const cohortCands: Array<MixtureFit | null> = [];
    for (let k = 1; k <= mixtureK; k += 1) {
      if (storeMixture === null) {
        storeCands.push(fitMixture(storeGaps, storeCens, k, { priorMu: priorMu0, sigma0 }));
      }
      if (cohortMixture === null) {
        cohortCands.push(fitMixture(cohortGaps, cohortCens, k, { priorMu: priorMu0, sigma0 }));
      }
    }
    if (storeMixture === null) storeMixture = selectMixtureK(storeCands);
    if (cohortMixture === null) cohortMixture = selectMixtureK(cohortCands);
  }
  if (input.mixtureEvidence !== undefined) {
    input.mixtureEvidence.store = storeMixture;
    input.mixtureEvidence.cohort = cohortMixture;
    // Fresco por llamada: evita mezclar resp de otra partición si el objeto
    // se reutiliza por error (el caller crea uno por partición).
    input.mixtureEvidence.respById = new Map();
  }

  // Fracción cura por nivel (issue #10 P1-3): proporción de censurados
  // viejos que probablemente jamás vuelvan. Acotada para no matar la señal.
  // Renovación: viejos = t > 3*ciclo entre F>=2. Segunda compra: t > 2*ciclo.
  const renewalOld = per.filter((p) => p.episodes.length >= 2 && p.t > 3 * cycle).length;
  const renewalTotal = Math.max(1, per.filter((p) => p.episodes.length >= 2).length);
  const f1Old = cohortCens.filter((t) => t > 2 * cycle).length;
  const f1Total = Math.max(1, cohortCens.length + cohortGaps.length);
  const cureRenewal = Math.min(0.4, renewalOld / renewalTotal);
  const cureSecond = Math.min(0.7, Math.max(0.2, f1Old / f1Total));

  // Moneda estricta para ticket (issue #10 P2): null ya no es comodín.
  // Sin sesiones en la moneda de la tienda ⇒ ticket=null, valor=null
  // (antes se fabricaba la mediana).
  const strictSameCurrency = (sessionCur: string | null, shopCur: string | null): boolean => {
    if (shopCur === null) return true;
    if (sessionCur === null) return false;
    return sessionCur.toUpperCase() === shopCur.toUpperCase();
  };
  // Ticket: m0 = mediana de ticket de episodio en la moneda de la tienda
  // (issue #27 Paso 1: en legacy cada episodio = 1 sesión ⇒ idéntico a v2).
  const poolTickets: number[] = [];
  for (const p of per) {
    for (const s of p.episodes) {
      if (strictSameCurrency(s.currency, input.shopCurrency)) poolTickets.push(s.ticketMinor);
    }
  }
  const m0 = medianOf(poolTickets);
  const K = 3;

  // Ticket* por cliente (para el decil superior B2B).
  const ticketById = new Map<string, number | null>();
  const sessionsInShopById = new Map<string, number>();
  for (const p of per) {
    let sum = 0;
    let n = 0;
    for (const s of p.episodes) {
      if (strictSameCurrency(s.currency, input.shopCurrency)) {
        sum += s.ticketMinor;
        n += 1;
      }
    }
    sessionsInShopById.set(p.id, n);
    let ticket: number | null = null;
    if (n === 0) {
      ticket = null;
    } else if (m0 !== null) {
      ticket = Math.round((K * m0 + sum) / (K + n));
    } else {
      ticket = Math.round(sum / n);
    }
    ticketById.set(p.id, ticket);
  }
  const ticketVals = [...ticketById.values()].filter((v): v is number => v !== null).sort(
    (a, b) => a - b,
  );
  // Decil real con n mínimo (issue #10 P2): con n<10 el floor(0.9·(n-1))
  // marcaba 33% como top en tiendas de 6. Ahora: n<10 ⇒ solo el máximo
  // es top; n>=10 ⇒ umbral ceil(0.9·n).
  let topDecilThreshold: number | null = null;
  if (ticketVals.length >= 10) {
    topDecilThreshold = ticketVals[Math.min(ticketVals.length - 1, Math.ceil(0.9 * ticketVals.length) - 1)];
  } else if (ticketVals.length > 0) {
    topDecilThreshold = ticketVals[ticketVals.length - 1];
  }

  const nStoreWithGaps = per.filter((p) => p.gaps.length >= 1).length;
  const cohortCases = cohortGaps.length + cohortCens.length;

  // B2B-only: todo cliente es empresa; sin tipo ⇒ B2B (fallback legacy true).
  const isB2BClient = (c: CustomerSessions): boolean => {
    const t = (c.customerType ?? "").trim().toUpperCase();
    if (t === "B2C") return true; // legacy: se normaliza a B2B
    return true;
  };

  // Lado por cliente + deciles por lado (issue #21 Paso 4). Sin tipos
  // explícitos todos caen al legacy ⇒ pools idénticos a v2.
  const sideById = new Map<string, boolean>();
  const marketById = new Map<string, string | null>();
  for (const c of input.customers) {
    sideById.set(c.customerId, isB2BClient(c));
    const m = (c.marketId ?? null) as string | null;
    marketById.set(c.customerId, m);
  }
  const b2bVals = [...ticketById.entries()]
    .filter(([id, v]) => v !== null && sideById.get(id) === true)
    .map(([, v]) => v as number)
    .sort((a, b) => a - b);
  const b2cVals = [...ticketById.entries()]
    .filter(([id, v]) => v !== null && sideById.get(id) !== true)
    .map(([, v]) => v as number)
    .sort((a, b) => a - b);
  const sideThreshold = (vals: number[]): number | null => {
    if (vals.length >= 10) return vals[Math.min(vals.length - 1, Math.ceil(0.9 * vals.length) - 1)];
    if (vals.length > 0) return vals[vals.length - 1];
    return null;
  };
  const topB2B = sideThreshold(b2bVals);
  const topB2C = sideThreshold(b2cVals);

  // Cortes de banda por tenant (issue #21 Paso 5): con defaults reproducen
  // v2 (0.6/0.15). Validación estricta: fuera de rango o high<=low ⇒ defaults.
  const bandHighRaw = input.bandHigh;
  const bandLowRaw = input.bandLow;
  const bandHigh =
    typeof bandHighRaw === "number" && Number.isFinite(bandHighRaw) && bandHighRaw > 0 && bandHighRaw < 1
      ? bandHighRaw
      : BAND_HIGH_DEFAULT;
  const bandLow =
    typeof bandLowRaw === "number" && Number.isFinite(bandLowRaw) && bandLowRaw >= 0 && bandLowRaw < 1
      ? bandLowRaw
      : BAND_LOW_DEFAULT;
  const [effHigh, effLow] = bandHigh > bandLow ? [bandHigh, bandLow] : [BAND_HIGH_DEFAULT, BAND_LOW_DEFAULT];

  const out: Prediction[] = [];
  for (const p of per) {
    if (p.episodes.length === 0 || p.lastAt === null) continue;
    const nSessions = p.episodes.length;
    const isRenewal = nSessions >= 2;
    // Camino mezcla (issue #27 Paso 2): solo si el K elegido del nivel es
    // ≥2; con K=1 se usa el camino legacy exacto (grilla jerárquica).
    const levelMixture = isRenewal ? storeMixture : cohortMixture;
    const useMixture = levelMixture !== null && levelMixture.k >= 2;
    const resp = useMixture && levelMixture !== null
      ? mixtureResponsibilities(p.gaps, p.t, levelMixture)
      : null;
    if (useMixture && resp !== null && input.mixtureEvidence?.respById !== undefined) {
      input.mixtureEvidence.respById.set(p.id, resp);
    }
    // Jerárquico real (issue #10 P1-2): prior paramétrico desde la media de
    // tienda + dispersión entre clientes, datos del cliente una sola vez.
    const grid = !useMixture
      ? (isRenewal ? fitClientGrid(storeMu, priorSigmaMu, sigma0, p.gaps, p.t) : cohortGrid)
      : null;
    const cure = isRenewal ? cureRenewal : cureSecond;
    const pr = useMixture && levelMixture !== null && resp !== null
      ? predictFromMixture(levelMixture, resp, p.t, H, cure)
      : predictFromGrid(grid ?? cohortGrid, p.t, H, cure);
    const ticket = ticketById.get(p.id) ?? null;
    const valor = ticket === null ? null : Math.round(pr.pMean * ticket);

    let confidence: Prediction["confidence"];
    if (nStoreWithGaps < 5) {
      confidence = "baja";
    } else if (!isRenewal && cohortCases < 10) {
      confidence = "baja";
    } else if (isRenewal && p.gaps.length >= 4) {
      confidence = "alta";
    } else {
      confidence = "media";
    }

    // Ejes de segmentación (issue #14A) + decisión versionada.
    // Desviación documentada vs el texto literal del issue #5 para los
    // ejemplos de control: organico solo en ventana temprana (t<0.8ciclo);
    // actuar sin techo superior una vez vencido.
    const sup = input.suppressed.get(p.id);
    const elegibilidad: Prediction["elegibilidad"] =
      sup === "sin_canal" ? "sin-canal" : sup === "contactado_reciente" ? "contacto-reciente" : "ok";
    const ritmo: Prediction["ritmo"] = isRenewal ? "con-ritmo" : "primera";
    const bandaP: Prediction["bandaP"] =
      pr.pMean > effHigh ? "organico-probable" : pr.pMean >= effLow ? "recuperable" : "lejos";
    let ventana: Prediction["ventana"];
    if (p.t > 3 * cycle) {
      const cdfT = useMixture && levelMixture !== null && resp !== null
        ? mixtureCdf(p.t, levelMixture, resp)
        : predictiveCdf(p.t, grid ?? cohortGrid);
      const sLn = Math.max(0, Math.min(1, 1 - cdfT));
      const pChurn = cure > 0 ? cure / (cure + (1 - cure) * Math.max(1e-9, sLn)) : 1 - sLn > 0.9 ? 1 : 0;
      const isDormido = cure > 0 ? pChurn > 0.7 : pr.sT < 0.1;
      ventana = isDormido ? "dormido" : pr.p75 !== null && p.t > pr.p75 ? "pasada" : "en";
    } else if (p.t < 0.8 * cycle) {
      ventana = "antes";
    } else if (pr.p75 !== null && p.t > pr.p75) {
      ventana = "pasada";
    } else {
      ventana = "en";
    }
    let valorDecil: number | null = null;
    const sideB2B = sideById.get(p.id) ?? true;
    const sidePool = sideB2B ? b2bVals : b2cVals;
    const pool = sidePool.length > 0 ? sidePool : ticketVals;
    if (ticket !== null && pool.length > 0) {
      const rank = pool.filter((v) => v <= ticket).length;
      valorDecil = Math.min(10, Math.max(1, Math.ceil((rank / pool.length) * 10)));
    }
    const ventanaAcotada = pr.p75 !== null && pr.p75 <= 4 * cycle;
    const intervaloAncho = pr.pHigh - pr.pLow > 0.6;
    const sideTop = sideB2B ? (topB2B ?? topDecilThreshold) : (topB2C ?? topDecilThreshold);
    const topDecil = ticket !== null && sideTop !== null && ticket >= sideTop;
    const decision = decideFromAxes(
      { ritmo, ventana, bandaP, valorDecil, elegibilidad },
      { isB2B: sideB2B, confidence, ventanaAcotada, intervaloAncho, topDecil },
    );

    out.push({
      customerId: p.id,
      marketId: input.marketId ?? marketById.get(p.id) ?? null,
      model: isRenewal ? "renovacion" : "segunda_compra",
      pRecompraH: round3(pr.pMean),
      pLow: round3(pr.pLow),
      pHigh: round3(pr.pHigh),
      expectedDays: pr.expDays,
      p25Days: pr.p25,
      p75Days: pr.p75,
      ticketEsperadoMinor: ticket,
      valorEsperadoMinor: valor,
      decision,
      confidence,
      ritmo,
      ventana,
      bandaP,
      valorDecil,
      elegibilidad,
      decisionVersion: DECISION_VERSION,
    });
  }
  return out;
}
