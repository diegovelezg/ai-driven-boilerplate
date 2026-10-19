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
 *  v3:market = partición por market + isB2B por lado + bandas por tenant
 *  (issue #21 Pasos 3-5). Con defaults reproduce v2 numéricamente. */
export const DECISION_VERSION = "v3:market";

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
 *  en ventana temprana es organico → dormido (salvo top B2B) →
 *  recuperable en ventana con confianza e intervalo acotados es actuar →
 *  resto vigilar. */
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
  if (axes.ventana === "dormido") {
    return opts.topDecil && opts.isB2B ? "revision_humana" : "dormido";
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
   *  `customerType`. Con tipos por cliente, la excepción dormido→
   *  revision_humana se evalúa por lado. */
  isB2B?: boolean;
  /** Etiqueta de la partición (issue #21 Paso 3). Se propaga a Prediction. */
  marketId?: string | null;
  /** Cortes de banda_p por tenant (issue #21 Paso 5). Null/inválido ⇒
   *  defaults 0.6/0.15 (reproducen v2). Calibración intacta. */
  bandHigh?: number | null;
  bandLow?: number | null;
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
    gaps: number[];
    t: number;
    lastAt: number | null;
  }
  const per: PerCustomer[] = input.customers.map((c) => {
    const sessions = [...c.sessions].sort((a, b) => a.at - b.at);
    const gaps: number[] = [];
    for (let i = 1; i < sessions.length; i += 1) {
      const g = (sessions[i].at - sessions[i - 1].at) / DAY_MS;
      if (g > 0) gaps.push(g);
    }
    const lastAt = sessions.length > 0 ? sessions[sessions.length - 1].at : null;
    const t = lastAt === null ? 0 : Math.max(0, (input.asOf - lastAt) / DAY_MS);
    return { id: c.customerId, sessions, gaps, t, lastAt };
  });

  // Grilla de tienda SOLO con F>=2 (issue #10 P1-3): los censurados F=1
  // (que mayormente jamás vuelven) contaminaban μ/σ de la prior de
  // renovación. El Modelo A aprende solo de renovadores reales.
  const storeGaps: number[] = [];
  const storeCens: number[] = [];
  for (const p of per) {
    if (p.sessions.length < 2) continue;
    for (const g of p.gaps) storeGaps.push(g);
    storeCens.push(p.t);
  }
  const storeGrid = fitGrid(storeGaps, storeCens, priorMu0, priorSigmaMu, sigma0);
  const storeMu = gridMuMean(storeGrid);

  // Cohorte F=1: tiempo hasta la 2ª sesión (completado) o censura.
  const cohortGaps: number[] = [];
  const cohortCens: number[] = [];
  for (const p of per) {
    if (p.sessions.length === 0) continue;
    if (p.sessions.length >= 2) {
      const first = (p.sessions[1].at - p.sessions[0].at) / DAY_MS;
      if (first > 0) cohortGaps.push(first);
    } else {
      cohortCens.push(p.t);
    }
  }
  const cohortGrid = fitGrid(cohortGaps, cohortCens, priorMu0, priorSigmaMu, sigma0);

  // Fracción cura por nivel (issue #10 P1-3): proporción de censurados
  // viejos que probablemente jamás vuelvan. Acotada para no matar la señal.
  // Renovación: viejos = t > 3*ciclo entre F>=2. Segunda compra: t > 2*ciclo.
  const renewalOld = per.filter((p) => p.sessions.length >= 2 && p.t > 3 * cycle).length;
  const renewalTotal = Math.max(1, per.filter((p) => p.sessions.length >= 2).length);
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
  // Ticket: m0 = mediana de ticket de sesión en la moneda de la tienda.
  const poolTickets: number[] = [];
  for (const p of per) {
    for (const s of p.sessions) {
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
    for (const s of p.sessions) {
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

  // Tipo efectivo por cliente (issue #21 Paso 4): customerType del input
  // (ya resuelto por el caller como manual_edits ?? customer_type) manda;
  // sin tipo ⇒ fallback al global legacy (puro-B2C/B2B idénticos a v2).
  const legacyB2B = input.isB2B === true;
  const isB2BClient = (c: CustomerSessions): boolean => {
    const t = (c.customerType ?? "").trim().toUpperCase();
    if (t === "B2B") return true;
    if (t === "B2C") return false;
    return legacyB2B;
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
    if (p.sessions.length === 0 || p.lastAt === null) continue;
    const nSessions = p.sessions.length;
    const isRenewal = nSessions >= 2;
    // Jerárquico real (issue #10 P1-2): prior paramétrico desde la media de
    // tienda + dispersión entre clientes, datos del cliente una sola vez.
    const grid = isRenewal
      ? fitClientGrid(storeMu, priorSigmaMu, sigma0, p.gaps, p.t)
      : cohortGrid;
    const cure = isRenewal ? cureRenewal : cureSecond;
    const pr = predictFromGrid(grid, p.t, H, cure);
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
      const sLn = Math.max(0, Math.min(1, 1 - predictiveCdf(p.t, grid)));
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
    const sideB2B = sideById.get(p.id) ?? legacyB2B;
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
