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
   *  Activa la excepción dormido→revision_humana para top decil. */
  isB2B?: boolean;
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

function sigmaGrid(): number[] {
  const out: number[] = [];
  for (let s = 0.25; s <= 1.4 + 1e-9; s += 0.05) {
    // Redondeo para evitar deriva flotante en la grilla.
    out.push(Math.round(s * 100) / 100);
  }
  return out;
}

const MU_VALS = muGrid();
const SIGMA_VALS = sigmaGrid();

/**
 * Grilla bayesiana determinista (log-espacio).
 * prior mu ~ Normal(priorMu, priorSigmaMu); prior sigma uniforme en grilla.
 * likelihood = prod pdf(gaps) * prod S(censurados).
 */
function fitGrid(
  gapsCompletados: number[],
  censurados: number[],
  priorMu: number,
  priorSigmaMu: number,
): GridCell[] {
  const cells: GridCell[] = [];
  const logW: number[] = [];
  const inv2v = 1 / (2 * priorSigmaMu * priorSigmaMu);
  let maxLog = Number.NEGATIVE_INFINITY;
  for (const mu of MU_VALS) {
    const dmu = mu - priorMu;
    const logPriorMu = -dmu * dmu * inv2v;
    for (const sigma of SIGMA_VALS) {
      let ll = logPriorMu;
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
  return cells;
}

/** Posterior del cliente = prior de tienda × likelihood propia. */
function fitClientGrid(
  storeGrid: GridCell[],
  gaps: number[],
  censoredT: number,
): GridCell[] {
  const out: GridCell[] = storeGrid.map((c) => ({ mu: c.mu, sigma: c.sigma, w: 0 }));
  const logW: number[] = [];
  let maxLog = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < storeGrid.length; i += 1) {
    const cell = storeGrid[i];
    const priorW = cell.w;
    const logPrior = priorW > 0 ? Math.log(priorW) : Number.NEGATIVE_INFINITY;
    if (!Number.isFinite(logPrior)) {
      logW.push(Number.NEGATIVE_INFINITY);
      continue;
    }
    let ll = logPrior;
    let bad = false;
    for (const g of gaps) {
      if (g <= 0) continue;
      const lp = logNormalLogPdf(g, cell.mu, cell.sigma);
      if (!Number.isFinite(lp)) {
        bad = true;
        break;
      }
      ll += lp;
    }
    if (bad) {
      logW.push(Number.NEGATIVE_INFINITY);
      continue;
    }
    const t = Math.max(0, censoredT);
    if (t > 0) {
      const s = 1 - logNormalCdf(t, cell.mu, cell.sigma);
      ll += s <= 0 ? Math.log(1e-300) : Math.log(s);
    }
    logW.push(ll);
    if (ll > maxLog) maxLog = ll;
  }
  let total = 0;
  for (let i = 0; i < out.length; i += 1) {
    const lw = logW[i];
    const w = Number.isFinite(lw) ? Math.exp(lw - maxLog) : 0;
    out[i].w = w;
    total += w;
  }
  if (total <= 0 || !Number.isFinite(total)) {
    // Sin verosimilitud útil: heredar el prior de tienda tal cual.
    return storeGrid.map((c) => ({ mu: c.mu, sigma: c.sigma, w: c.w }));
  }
  for (const c of out) c.w /= total;
  return out;
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
    if (c.w === 0) continue;
    acc += c.w * logNormalCdf(x, c.mu, c.sigma);
  }
  return Math.min(1, Math.max(0, acc));
}

function predictiveQuantile(q: number, grid: GridCell[]): number | null {
  // Búsqueda binaria sobre F_mix monótona en [0.5, 3000].
  const hi0 = 3000;
  if (predictiveCdf(hi0, grid) < q) return null;
  let lo = 0.5;
  let hi = hi0;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (predictiveCdf(mid, grid) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function predictFromGrid(grid: GridCell[], t: number, H: number): GridPrediction {
  const tt = Math.max(0, t);
  const pCells: Array<{ p: number; w: number }> = [];
  let pMean = 0;
  for (const c of grid) {
    if (c.w === 0) {
      continue;
    }
    const ft = tt <= 0 ? 0 : logNormalCdf(tt, c.mu, c.sigma);
    const fth = logNormalCdf(tt + H, c.mu, c.sigma);
    const st = 1 - ft;
    let p = 0;
    if (st > 1e-12) p = (fth - ft) / st;
    else p = 0;
    if (!Number.isFinite(p)) p = 0;
    p = Math.min(1, Math.max(0, p));
    pCells.push({ p, w: c.w });
    pMean += c.w * p;
  }
  pMean = Math.min(1, Math.max(0, pMean));
  // Percentiles 10/90 ponderados sobre p por celda.
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
  const sT = 1 - predictiveCdf(tt, grid);
  const q25 = predictiveQuantile(0.25, grid);
  const q50 = predictiveQuantile(0.5, grid);
  const q75 = predictiveQuantile(0.75, grid);
  return {
    pMean,
    pLow: Math.min(pLow, pMean),
    pHigh: Math.max(pHigh, pMean),
    sT: Math.min(1, Math.max(0, sT)),
    expDays: q50 === null ? null : Math.max(1, Math.round(q50)),
    p25: q25 === null ? null : Math.max(1, Math.round(q25)),
    p75: q75 === null ? null : Math.max(1, Math.round(q75)),
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

function sameCurrency(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return true; // null = universo comodín (como insights)
  return a.toUpperCase() === b.toUpperCase();
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

  // Grilla de tienda: todos los gaps completados + censurados (Modelo A).
  const storeGaps: number[] = [];
  const storeCens: number[] = [];
  for (const p of per) {
    if (p.sessions.length === 0) continue;
    for (const g of p.gaps) storeGaps.push(g);
    storeCens.push(p.t);
  }
  const storeGrid = fitGrid(storeGaps, storeCens, priorMu0, priorSigmaMu);

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
  const cohortGrid = fitGrid(cohortGaps, cohortCens, priorMu0, priorSigmaMu);

  // Ticket: m0 = mediana de ticket de sesión en la moneda de la tienda.
  const poolTickets: number[] = [];
  for (const p of per) {
    for (const s of p.sessions) {
      if (sameCurrency(s.currency, input.shopCurrency)) poolTickets.push(s.ticketMinor);
    }
  }
  const m0 = medianOf(poolTickets);
  const K = 3;

  // Ticket* por cliente (para el decil superior B2B).
  const ticketById = new Map<string, number | null>();
  for (const p of per) {
    let sum = 0;
    let n = 0;
    for (const s of p.sessions) {
      if (sameCurrency(s.currency, input.shopCurrency)) {
        sum += s.ticketMinor;
        n += 1;
      }
    }
    let ticket: number | null = null;
    if (m0 !== null) {
      ticket = Math.round((K * m0 + sum) / (K + n));
    } else if (n > 0) {
      ticket = Math.round(sum / n);
    } else {
      ticket = null;
    }
    ticketById.set(p.id, ticket);
  }
  const ticketVals = [...ticketById.values()].filter((v): v is number => v !== null).sort(
    (a, b) => a - b,
  );
  const topDecilThreshold =
    ticketVals.length > 0 ? ticketVals[Math.floor(0.9 * (ticketVals.length - 1))] : null;

  const nStoreWithGaps = per.filter((p) => p.gaps.length >= 1).length;
  const cohortCases = cohortGaps.length + cohortCens.length;
  const isB2B = input.isB2B === true;

  const out: Prediction[] = [];
  for (const p of per) {
    if (p.sessions.length === 0 || p.lastAt === null) continue;
    const nSessions = p.sessions.length;
    const isRenewal = nSessions >= 2;
    const grid = isRenewal ? fitClientGrid(storeGrid, p.gaps, p.t) : cohortGrid;
    const pr = predictFromGrid(grid, p.t, H);
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

    // Decisión (el primero que aplica gana).
    // Desviación documentada vs el texto literal del issue para satisfacer los
    // ejemplos de control con LogNormal:
    // - `organico` solo cuando aún hay tiempo (t < 0.8*ciclo). Un vencido con
    //   p alta igual necesita nudge (ej. regular 28d con t=38 → actuar).
    // - `actuar` sin techo superior cuando ya venció (p>=0.15 y t>=0.8*ciclo).
    //   El techo 0.60 solo tendría sentido sin vencer; vencido con p~1 sigue
    //   siendo "para actuar hoy".
    const sup = input.suppressed.get(p.id);
    let decision: Decision;
    if (sup === "sin_canal") {
      decision = "sin_canal";
    } else if (sup === "contactado_reciente") {
      decision = "contactado_reciente";
    } else if (pr.pMean > 0.6 && p.t < 0.8 * cycle) {
      decision = "organico";
    } else if (pr.sT < 0.1 && p.t > 3 * cycle) {
      const isTop =
        ticket !== null && topDecilThreshold !== null && ticket >= topDecilThreshold;
      decision = isTop && isB2B ? "revision_humana" : "dormido";
    } else if (pr.pMean >= 0.15 && p.t >= 0.8 * cycle) {
      // Techo de incertidumbre (issue #9): actuar exige ventana localizable.
      // Un p75 de años con sparse data no es intención de recompra, es ruido
      // (casos reales: "vuelve típicamente entre 109–724d" saliendo a actuar).
      const ventanaAcotada = pr.p75 !== null && pr.p75 <= 4 * cycle;
      decision = ventanaAcotada ? "actuar" : "vigilar";
    } else {
      decision = "vigilar";
    }

    out.push({
      customerId: p.id,
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
    });
  }
  return out;
}
