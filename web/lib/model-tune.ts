// Tune mensual del modelo por tenant (issue #27 Paso 4): re-aprende la
// ventana de episodio y la mezcla K con backtest obligatorio contra la
// versión vigente. Solo se aplica si la candidata gana por margen y pasa
// guardarraíles; lo estructural (cambio de K) no se auto-aplica.
//
// Métrica de éxito (Paso 5.3, definida antes de medirse):
// - Backtest multi-tenant: la mezcla no puede perder contra el modelo actual
//   en calibración (gate `releaseGateTenants` en tests: heterogéneos ganan,
//   homogéneos empatan exacto por camino legacy).
// - Producción (observacional, para el operador): la fracción de la base en
//   `dormido` solo debe bajar si el retorno observado de los reclasificados
//   lo respalda; si bajamos dormidos y nadie vuelve, el cambio empeoró
//   aunque el dashboard se vea mejor.
//
// Se evalúa POR PARTICIÓN (market), espejando producción: misma asignación
// `assignMarket`, mismas órdenes por partición (market null = compartida) y
// solo clientes con compras reales. Nunca mezcla monedas ni comportamientos
// entre particiones: cada una ajusta, valida y escribe su propia fila
// (market_id; null = partición sin market, que además sirve de fallback
// global por el contrato vigente de resolución). La predicción
// diaria NUNCA reajusta: entre tunes los parámetros quedan fijos.
// La mezcla candidata es la de nivel tienda y se evalúa y aplica en AMBOS
// niveles (renovación y cohorte), igual que producción la aplicaría: el
// backtest mide exactamente el artefacto desplegable, no un fit por nivel.
//
// Enganche: `profile-recalibrate/service.ts` (post-sync, junto a bandas),
// con throttle propio de 30d por partición (`fitted_at` en Postgres de filas
// de versión soportada) y fail-open total (nunca rompe el recalibrado).
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { isRealOrder } from "@/lib/medusa";
import {
  ARCHETYPES,
  getStoreProfile,
  resolveTenantCycleDays,
} from "@/lib/store-profiles";
import {
  assignMarket,
  listStoreMarkets,
  type TenantMarket,
} from "@/lib/markets";
import {
  EPISODE_VERSION,
  HORIZON_BY_ARCHETYPE,
  MIXTURE_VERSION,
  SIGMA0_BY_ARCHETYPE,
  asValidMixtureFit,
  predictStore,
  sessionize,
  type CustomerSessions,
  type MixtureEvidence,
  type MixtureLike,
} from "@/lib/retention-model";
import {
  isSupportedModelParamsVersion,
  paramsForPartition,
  resolveModelParams,
  writeModelParams,
  type LearnedMixture,
  type TenantModelParams,
} from "@/lib/model-params";

const DAY_MS = 86_400_000;

/** Cadencia del tune por tenant (misma doctrina que bandas: cada tenant su reloj). */
const MODEL_TUNE_DAYS = 30;
/** Mínimos para no calibrar en el vacío (conservar y decirlo, como bandas). */
const MODEL_TUNE_MIN_SCORED = 60;
const MODEL_TUNE_MIN_EVENTS = 10;
/** Margen de victoria en Brier + tolerancia en log-loss (v1, documentado).
 *  El fijo se usa cuando no hay muestras pareadas; con muestras manda el
 *  margen por ruido (2·SE, con piso absoluto). */
export const MODEL_TUNE_BRIER_MARGIN = 0.003;
const MODEL_TUNE_LOGLOSS_TOL = 0.002;
/** Margen por ruido: la victoria debe superar k·SE pareado (k=2) y un piso
 *  absoluto (una mejora microscópica aunque "significativa" no justifica
 *  mover producción). */
const MODEL_TUNE_WIN_K_SE = 2;
const MODEL_TUNE_MIN_ABS_MARGIN = 0.0005;
/** Tope del horizonte de validación (ver tuneValidationHorizon). */
const MODEL_TUNE_MAX_VALIDATION_H = 180;
/** Emergencia en frío: doble margen para activar K≤2 sin fila previa. */
const MODEL_TUNE_EMERGENCE_MULT = 2;
/** La ventana solo se mueve si el cambio es ≥2 días (anti-churn por ruido). */
const MODEL_TUNE_WINDOW_MIN_MOVE_DAYS = 2;
/** Trust region por ciclo sobre componentes (μ/σ) dentro de la misma K. */
const MODEL_TUNE_MAX_DMU = 0.5;
const MODEL_TUNE_MAX_DSIGMA = 0.2;
/** Ventanas candidatas además de la vigente (días; la vigente siempre entra). */
const TUNE_WINDOW_CANDIDATES = [7, 14, 30];
/** K máximo evaluado por EM (guardarraíles de selectMixtureK aplican). */
const TUNE_MIXTURE_MAXK = 4;

export interface TuneOrder {
  customerId: string;
  at: number;
  ticketMinor: number;
  currency: string | null;
  /** Market de la orden (null = compartida entre particiones, como producción). */
  marketId?: string | null;
}

/** Cliente para asignación por market (solo id + país; las compras mandan). */
export interface TuneCustomer {
  id: string;
  country: string | null;
}

export interface TunePartition {
  marketId: string | null;
  /** Etiqueta humana para el reason (nombre del market o "sin market"). */
  label: string;
  customers: TuneCustomer[];
  /** Todas las órdenes de la partición (cualquier fecha; el corte filtra). */
  orders: TuneOrder[];
}

/** Particiona el dataset como producción (issue #27 Paso 4 + #21 Paso 3):
 *  misma asignación `assignMarket` (mayoría ≤ corte, fallback país, null),
 *  misma regla de órdenes (market null = compartida con todas), y
 *  SOLO clientes con compras reales ≤ corte (sin sesiones no hay predicción,
 *  igual que el run diario). Nunca mezcla monedas ni comportamientos entre
 *  particiones: cada una se ajusta y valida por separado. */
export function partitionTuneDataset(
  customers: TuneCustomer[],
  orders: TuneOrder[],
  markets: TenantMarket[],
  cutoffMs: number,
): TunePartition[] {
  const byCustOrders = new Map<string, TuneOrder[]>();
  for (const o of orders) {
    if (!Number.isFinite(o.at)) continue;
    const arr = byCustOrders.get(o.customerId) ?? [];
    arr.push(o);
    byCustOrders.set(o.customerId, arr);
  }
  const countryById = new Map(customers.map((c) => [c.id, c.country ?? null]));
  const assignedById = new Map<string, string | null>();
  for (const [cid, ords] of byCustOrders) {
    const mids = ords.filter((o) => o.at <= cutoffMs).map((o) => o.marketId ?? null);
    assignedById.set(cid, assignMarket(mids, countryById.get(cid) ?? null, markets));
  }
  const groups = new Map<string | null, { customers: TuneCustomer[]; orders: TuneOrder[] }>();
  for (const [cid, ords] of byCustOrders) {
    // Sin compras reales ≤ corte el cliente no participa (como producción).
    if (!ords.some((o) => o.at <= cutoffMs)) continue;
    const assigned = assignedById.get(cid) ?? null;
    let g = groups.get(assigned);
    if (!g) {
      g = { customers: [], orders: [] };
      groups.set(assigned, g);
    }
    g.customers.push({ id: cid, country: countryById.get(cid) ?? null });
    for (const o of ords) {
      if (assigned === null || o.marketId == null || o.marketId === assigned) g.orders.push(o);
    }
  }
  const nameById = new Map(markets.map((m) => [m.id, m.name ?? m.id]));
  return [...groups.entries()].map(([marketId, g]) => ({
    marketId,
    label: marketId === null ? "sin market" : (nameById.get(marketId) ?? marketId),
    customers: g.customers,
    orders: g.orders,
  }));
}

export interface TuneScored {
  customerId: string;
  p: number;
  returned: boolean;
  /** Origen WFO (índice de corte) para parear muestras pooled. */
  origin?: number;
}

export interface TuneDecile {
  n: number;
  meanP: number;
  observed: number;
}

export interface TuneScores {
  n: number;
  events: number;
  brier: number;
  logLoss: number;
  liftTop: number | null;
  baseRate: number;
  deciles: TuneDecile[];
}

/** Configuración evaluable: ventana + mezcla única (nivel tienda, aplicada
 *  en ambos niveles como producción). mixture null = grilla única (legacy).
 *  `samples` (opcional) habilita el margen por ruido; sin muestras rige el
 *  margen fijo (compatibilidad). */
export interface TuneEntry {
  window: number | null;
  mixture: MixtureLike | null;
  scores: TuneScores;
  samples?: TuneScored[];
}

export interface TuneCurrent {
  window: number | null;
  mixture: MixtureLike | null;
  hasRow: boolean;
}

export type TuneAction = "apply" | "keep" | "propose";

export interface TuneDecision {
  action: TuneAction;
  /** Solo con action=apply: lo que el escritor persiste. */
  candidate: { window: number | null; mixture: LearnedMixture | null } | null;
  reason: string;
}

/** Evaluación WFO (walk-forward, issue #27): lo mismo que el tune haría en
 *  cada origen, pooled. Cada origen ajusta su propia mezcla (honesto: sin
 *  leak del futuro) y la mezcla candidata a persistir es la del corte más
 *  reciente (C0). Puro. */
export interface TuneWfoWindow {
  window: number | null;
  /** Mezcla ajustada en el corte más reciente (la persistible). */
  mixture: MixtureLike | null;
  pooled: TuneScored[];
  origins: Array<{ cutoff: number; n: number; events: number; brier: number; k: number }>;
}

export function evaluateTuneWFO(
  orders: TuneOrder[],
  customers: TuneCustomer[],
  markets: TenantMarket[],
  cutoffs: number[],
  base: { cycleDays: number; sigma0: number },
  currentFor: (marketId: string | null) => TuneCurrent,
  scoreHorizonDays: number,
): Map<string | null, { label: string; currentPooled: TuneScored[]; perWindow: TuneWfoWindow[] }> {
  const H = scoreHorizonDays > 0 && Number.isFinite(scoreHorizonDays) ? scoreHorizonDays : 30;
  const byMarket = new Map<string | null, {
    label: string;
    currentPooled: TuneScored[];
    byWindow: Map<string, { window: number | null; mixture: MixtureLike | null; pooled: TuneScored[]; origins: TuneWfoWindow["origins"] }>;
  }>();
  const labelOf = (m: string | null): string => {
    if (m === null) return "sin market";
    return markets.find((mk) => mk.id === m)?.name ?? m;
  };
  cutoffs.forEach((C, oi) => {
    // P2-2: la partición se rehace EN CADA origen con órdenes ≤ C (sin leak:
    // ni la asignación ni los clientes usan información posterior al corte).
    const partitions = partitionTuneDataset(customers, orders, markets, C);
    for (const part of partitions) {
      let e = byMarket.get(part.marketId);
      if (!e) {
        e = { label: labelOf(part.marketId), currentPooled: [], byWindow: new Map() };
        byMarket.set(part.marketId, e);
      }
      const current = currentFor(part.marketId);
      const sessions = buildTuneSessions(part.orders, C);
      const b: TuneEvalBase = { asOf: C, cycleDays: base.cycleDays, horizonDays: H, sigma0: base.sigma0 };
      const curPreds = evaluateTuneCurrent(sessions, b, current);
      e.currentPooled.push(
        ...labelTuneReturns(curPreds, part.orders, C, H).map((s) => ({ ...s, origin: oi })),
      );
      for (const w of enumerateTuneWindows(current.window)) {
        const { mixture, preds } = evaluateTuneWindow(sessions, b, w);
        const s = labelTuneReturns(preds, part.orders, C, H).map((x) => ({ ...x, origin: oi }));
        const sc = scoreTuneSamples(s);
        const key = String(w);
        let we = e.byWindow.get(key);
        if (!we) {
          we = { window: w, mixture: null, pooled: [], origins: [] };
          e.byWindow.set(key, we);
        }
        we.pooled.push(...s);
        we.origins.push({ cutoff: C, n: sc.n, events: sc.events, brier: sc.brier, k: mixture?.k ?? 1 });
        if (oi === 0) we.mixture = mixture;
      }
    }
  });
  const out = new Map<string | null, { label: string; currentPooled: TuneScored[]; perWindow: TuneWfoWindow[] }>();
  for (const [m, e] of byMarket) {
    out.set(m, { label: e.label, currentPooled: e.currentPooled, perWindow: [...e.byWindow.values()] });
  }
  return out;
}

/** Corte histórico: parámetros ajustados hasta C, retorno medido en (C,C+H]. */
export function tuneCutoff(nowMs: number, horizonDays: number): number {
  const h = horizonDays > 0 && Number.isFinite(horizonDays) ? horizonDays : 30;
  return nowMs - h * DAY_MS;
}

/** Sesiones por cliente con órdenes ≤ corte (espeja producción: sessionize). */
export function buildTuneSessions(orders: TuneOrder[], cutoffMs: number): CustomerSessions[] {
  const byCust = new Map<string, Array<{ placedAt: number; ticketMinor: number; currency: string | null }>>();
  for (const o of orders) {
    if (!Number.isFinite(o.at) || o.at > cutoffMs) continue;
    const arr = byCust.get(o.customerId) ?? [];
    arr.push({ placedAt: o.at, ticketMinor: o.ticketMinor, currency: o.currency });
    byCust.set(o.customerId, arr);
  }
  const out: CustomerSessions[] = [];
  for (const [customerId, ords] of byCust) {
    const sessions = sessionize(ords);
    if (sessions.length === 0) continue;
    out.push({ customerId, sessions });
  }
  return out;
}

/** Etiqueta orgánica de TODA la base (no solo contactados): retorno en (C,C+H]. */
export function labelTuneReturns(
  preds: Array<{ customerId: string; p: number }>,
  orders: TuneOrder[],
  cutoffMs: number,
  horizonDays: number,
): TuneScored[] {
  const h = horizonDays > 0 && Number.isFinite(horizonDays) ? horizonDays : 30;
  const end = cutoffMs + h * DAY_MS;
  const after = new Map<string, number[]>();
  for (const o of orders) {
    if (!Number.isFinite(o.at) || o.at <= cutoffMs || o.at > end) continue;
    const arr = after.get(o.customerId) ?? [];
    arr.push(o.at);
    after.set(o.customerId, arr);
  }
  return preds
    .filter((p) => Number.isFinite(p.p))
    .map((p) => ({
      customerId: p.customerId,
      p: Math.min(1, Math.max(0, p.p)),
      returned: (after.get(p.customerId) ?? []).length > 0,
    }));
}

/** Brier + log-loss + lift decil superior + calibración por decil de p. */
export function scoreTuneSamples(samples: TuneScored[]): TuneScores {
  const n = samples.length;
  const events = samples.filter((s) => s.returned).length;
  if (n === 0) {
    return { n: 0, events: 0, brier: 1, logLoss: 1, liftTop: null, baseRate: 0, deciles: [] };
  }
  let brier = 0;
  let ll = 0;
  for (const s of samples) {
    const y = s.returned ? 1 : 0;
    brier += (s.p - y) * (s.p - y);
    const pc = Math.min(1 - 1e-6, Math.max(1e-6, s.p));
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  brier /= n;
  ll /= n;
  const baseRate = events / n;
  const ranked = [...samples].sort((a, b) => b.p - a.p);
  const kTop = Math.max(1, Math.ceil(n / 10));
  const topEvents = ranked.slice(0, kTop).filter((s) => s.returned).length;
  const liftTop = baseRate > 0 && n >= 10 ? topEvents / kTop / baseRate : null;
  const asc = [...samples].sort((a, b) => a.p - b.p);
  const deciles: TuneDecile[] = [];
  for (let d = 0; d < 10; d += 1) {
    const lo = Math.floor((d * n) / 10);
    const hi = d === 9 ? n : Math.floor(((d + 1) * n) / 10);
    const slice = asc.slice(lo, hi);
    if (slice.length === 0) {
      deciles.push({ n: 0, meanP: 0, observed: 0 });
      continue;
    }
    deciles.push({
      n: slice.length,
      meanP: slice.reduce((a, s) => a + s.p, 0) / slice.length,
      observed: slice.filter((s) => s.returned).length / slice.length,
    });
  }
  return { n, events, brier, logLoss: ll, liftTop, baseRate, deciles };
}

/** Horizonte de validación (mismo método para todos, tempo por tenant):
 *  3×H con tope 180d. Cubre ~2 ciclos típicos sin aplanar la base rate ni
 *  pedir historia que un tenant joven no tiene (sin historia ⇒ mínimos ⇒
 *  keep, fail-safe). H=30→90, H=60→180, H=90→180. Es el horizonte con el que
 *  se PUNTÚA la estructura; el H de producción (acción) no cambia. */
export function tuneValidationHorizon(horizonDays: number): number {
  const h = horizonDays > 0 && Number.isFinite(horizonDays) ? horizonDays : 30;
  return Math.min(MODEL_TUNE_MAX_VALIDATION_H, 3 * h);
}

/** SE pareado de la diferencia de Brier (candidata − vigente) por cliente y
 *  origen. Null sin muestras o con <2 pares (el llamador usa el margen fijo).
 *  Es lo que impide que UN cliente decida el tune. */
export function pairedBrierSE(
  currentSamples: TuneScored[] | undefined,
  candSamples: TuneScored[] | undefined,
): number | null {
  if (!currentSamples || !candSamples || currentSamples.length === 0) return null;
  const keyOf = (s: TuneScored): string =>
    s.origin === undefined ? s.customerId : `${s.customerId}@${s.origin}`;
  const byId = new Map(currentSamples.map((s) => [keyOf(s), s]));
  const diffs: number[] = [];
  for (const s of candSamples) {
    const a = byId.get(keyOf(s));
    if (!a) continue;
    diffs.push((s.p - (s.returned ? 1 : 0)) ** 2 - (a.p - (a.returned ? 1 : 0)) ** 2);
  }
  if (diffs.length < 2) return null;
  const m = diffs.reduce((x, y) => x + y, 0) / diffs.length;
  const v = diffs.reduce((x, y) => x + (y - m) * (y - m), 0) / (diffs.length - 1);
  const se = Math.sqrt(Math.max(0, v) / diffs.length);
  return Number.isFinite(se) ? se : null;
}
/** Ventanas a evaluar: la vigente + candidatas + vuelta a legacy (si hay vigente). */
export function enumerateTuneWindows(currentWindow: number | null): Array<number | null> {
  const out: Array<number | null> = [];
  const push = (w: number | null): void => {
    if (!out.some((x) => x === w)) out.push(w);
  };
  if (currentWindow !== null) push(currentWindow);
  if (currentWindow !== null) push(null);
  for (const w of TUNE_WINDOW_CANDIDATES) push(w);
  return out;
}

export interface TuneEvalBase {
  asOf: number;
  cycleDays: number;
  horizonDays: number;
  sigma0: number;
}

function effectiveK(mixture: MixtureLike | null): number {
  return mixture?.k ?? 1;
}

/** Ajusta (EM, nivel tienda) y puntúa una configuración: el mismo artefacto
 *  que producción aplicaría (mezcla única en ambos niveles). Puro. */
export function evaluateTuneWindow(
  sessions: CustomerSessions[],
  base: TuneEvalBase,
  window: number | null,
): { mixture: MixtureLike | null; preds: Array<{ customerId: string; p: number }> } {
  const fitEv: MixtureEvidence = {};
  // P1: el ajuste usa la MISMA ventana candidata que la puntuación (mezcla
  // sobre episodios fusionados con w, no sobre sesiones legacy): lo que se
  // mide es lo que se desplegaría, y cada ventana compite con su mejor mezcla.
  predictStore({
    asOf: base.asOf,
    cycleDays: base.cycleDays,
    horizonDays: base.horizonDays,
    sigma0: base.sigma0,
    shopCurrency: null,
    customers: sessions,
    suppressed: new Map(),
    episodeGapDays: window,
    mixtureMaxK: TUNE_MIXTURE_MAXK,
    mixtureEvidence: fitEv,
  });
  // P2: el EM no acota μ: una mezcla fuera de rango operativo no es
  // persistible (el escritor la rechazaría) ⇒ se descarta aquí a legacy
  // antes de puntuar/decidir, no después de medir.
  const mixture = asValidMixtureFit(fitEv.store ?? null);
  const scored = predictStore({
    asOf: base.asOf,
    cycleDays: base.cycleDays,
    horizonDays: base.horizonDays,
    sigma0: base.sigma0,
    shopCurrency: null,
    customers: sessions,
    suppressed: new Map(),
    episodeGapDays: window,
    mixtureMaxK: null,
    mixtureStoreFit: mixture,
    mixtureCohortFit: mixture,
  });
  return {
    mixture,
    preds: scored.map((p) => ({ customerId: p.customerId, p: p.pRecompraH })),
  };
}

/** Puntúa la configuración vigente (mezcla aprendida o legacy) en el corte. */
export function evaluateTuneCurrent(
  sessions: CustomerSessions[],
  base: TuneEvalBase,
  current: { window: number | null; mixture: MixtureLike | null },
): Array<{ customerId: string; p: number }> {
  const scored = predictStore({
    asOf: base.asOf,
    cycleDays: base.cycleDays,
    horizonDays: base.horizonDays,
    sigma0: base.sigma0,
    shopCurrency: null,
    customers: sessions,
    suppressed: new Map(),
    episodeGapDays: current.window,
    mixtureMaxK: null,
    mixtureStoreFit: current.mixture,
    mixtureCohortFit: current.mixture,
  });
  return scored.map((p) => ({ customerId: p.customerId, p: p.pRecompraH }));
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** Decisión del tune (pura): márgenes, guardarraíles y doctrina HITL.
 *  Estructural (cambio de K) ⇒ propose, salvo emergencia en frío (sin fila,
 *  K≤2, victoria doble) que auto-aplica: así "aparece sola" la segmentación
 *  cuando los datos la sostienen. */
export function decideTune(
  current: TuneCurrent & { scores: TuneScores; samples?: TuneScored[] },
  entries: TuneEntry[],
  stats: { n: number; events: number },
  opts?: { horizonDays?: number },
): TuneDecision {
  const hLabel =
    typeof opts?.horizonDays === "number" && Number.isFinite(opts.horizonDays) && opts.horizonDays > 0
      ? `últimos ${Math.round(opts.horizonDays)} días`
      : "últimos días";
  const curK = effectiveK(current.mixture);
  if (stats.n < MODEL_TUNE_MIN_SCORED || stats.events < MODEL_TUNE_MIN_EVENTS) {
    return {
      action: "keep",
      candidate: null,
      reason:
        `Historia insuficiente para re-aprender el ritmo (${stats.n} muestras, ` +
        `${stats.events} retornos; mínimo ${MODEL_TUNE_MIN_SCORED}/${MODEL_TUNE_MIN_EVENTS}): ` +
        `se conserva la versión vigente.`,
    };
  }
  if (entries.length === 0) {
    return { action: "keep", candidate: null, reason: "Sin candidatas evaluables: se conserva." };
  }
  // Mejor por Brier; desempate: ventana vigente, luego K menor (cambio mínimo).
  const ranked = [...entries].sort((a, b) => {
    if (a.scores.brier !== b.scores.brier) return a.scores.brier - b.scores.brier;
    const aCur = a.window === current.window ? 0 : 1;
    const bCur = b.window === current.window ? 0 : 1;
    if (aCur !== bCur) return aCur - bCur;
    return effectiveK(a.mixture) - effectiveK(b.mixture);
  });
  let best = ranked[0];
  let windowNote = "";
  // La ventana solo se mueve si el cambio es ≥2 días (anti-churn por ruido).
  if (
    best.window !== current.window &&
    best.window !== null &&
    current.window !== null &&
    Math.abs(best.window - current.window) < MODEL_TUNE_WINDOW_MIN_MOVE_DAYS
  ) {
    const stay = entries.find((e) => e.window === current.window);
    if (stay !== undefined) {
      best = stay;
      windowNote = ` (ventana candidata a <${MODEL_TUNE_WINDOW_MIN_MOVE_DAYS}d de la vigente: se queda en ${current.window}d)`;
    }
  }
  const bestK = effectiveK(best.mixture);
  const dBrier = current.scores.brier - best.scores.brier;
  // Margen por ruido (si hay muestras pareadas) o fijo (compatibilidad):
  // la victoria debe superar k·SE con piso absoluto. Así un solo cliente
  // no decide el tune.
  const se = pairedBrierSE(current.samples, best.samples);
  const winMargin = se === null
    ? MODEL_TUNE_BRIER_MARGIN
    : Math.max(MODEL_TUNE_MIN_ABS_MARGIN, MODEL_TUNE_WIN_K_SE * se);
  if (dBrier < winMargin || best.scores.logLoss > current.scores.logLoss + MODEL_TUNE_LOGLOSS_TOL) {
    return {
      action: "keep",
      candidate: null,
      reason:
        `La versión vigente sigue ganando (Brier ${round4(current.scores.brier)} vs ` +
        `${round4(best.scores.brier)} con ${stats.n} muestras): se conserva${windowNote}.`,
    };
  }
  // Estructural: cambio de K.
  // Emergencia en frío: el ×2 de emergencia aplica al PISO, no al SE
  // (el SE ya escala con la evidencia; exigir 4σ bloquearía activaciones
  // legítimas de 3σ y contradiría "aparece sola cuando los datos la sostienen").
  const reqEmer = se === null
    ? MODEL_TUNE_EMERGENCE_MULT * winMargin
    : Math.max(MODEL_TUNE_EMERGENCE_MULT * MODEL_TUNE_MIN_ABS_MARGIN, MODEL_TUNE_WIN_K_SE * se);
  if (bestK !== curK) {
    if (
      !current.hasRow &&
      bestK <= 2 &&
      dBrier >= reqEmer
    ) {
      return {
        action: "apply",
        candidate: {
          window: best.window,
          mixture: best.mixture
            ? { k: best.mixture.k, components: best.mixture.components }
            : null,
        },
        reason:
          `Ajusté el ritmo de tu tienda: ahora distingo ${bestK} formas de comprar ` +
          `(ventana ${best.window ?? "legacy"}d); lo validé contra los ${hLabel} ` +
          `antes de aplicarlo (Brier ${round4(current.scores.brier)} → ${round4(best.scores.brier)}).`,
      };
    }
    return {
      action: "propose",
      candidate: null,
      reason:
        `Detecté que tu tienda tiene ${bestK} formas de comprar (vigente: ${curK}) ` +
        `con mejor Brier (${round4(current.scores.brier)} → ${round4(best.scores.brier)}), ` +
        `pero el cambio de estructura requiere revisión: no se auto-aplica, queda propuesto.`,
    };
  }
  // Trust region sobre componentes dentro de la misma K (si hay mezcla vigente).
  if (current.mixture !== null && best.mixture !== null) {
    for (let c = 0; c < best.mixture.components.length; c += 1) {
      const b = best.mixture.components[c];
      const a = current.mixture.components[Math.min(c, current.mixture.components.length - 1)];
      if (
        Math.abs(b.mu - a.mu) > MODEL_TUNE_MAX_DMU ||
        Math.abs(b.sigma - a.sigma) > MODEL_TUNE_MAX_DSIGMA
      ) {
        return {
          action: "keep",
          candidate: null,
          reason:
            `La candidata gana en Brier pero mueve un componente fuera de la trust ` +
            `region (|Δμ|≤${MODEL_TUNE_MAX_DMU}, |Δσ|≤${MODEL_TUNE_MAX_DSIGMA}): se conserva.`,
        };
      }
    }
  }
  return {
    action: "apply",
    candidate: {
      window: best.window,
      mixture: best.mixture ? { k: best.mixture.k, components: best.mixture.components } : null,
    },
    reason:
      current.mixture === null && best.mixture === null
        ? `Re-aprendí la ventana de episodio (${current.window ?? "legacy"}d → ${best.window ?? "legacy"}d) ` +
          `con mejor Brier (${round4(current.scores.brier)} → ${round4(best.scores.brier)}).`
        : `Ajusté el ritmo de tu tienda con los últimos datos ` +
          `(Brier ${round4(current.scores.brier)} → ${round4(best.scores.brier)})${windowNote}.`,
  };
}

export interface TunePartitionOutcome {
  marketId: string | null;
  label: string;
  action: TuneAction;
  wrote: boolean;
  samples: number;
  events: number;
  window: number | null;
  k: number | null;
  brierCurrent: number | null;
  brierCandidate: number | null;
  reason: string;
}

export interface ModelTuneOutcome {
  wrote: boolean;
  action: TuneAction;
  reason: string;
  partitions: TunePartitionOutcome[];
}

/** Tune mensual por partición (issue #27 Paso 4): re-aprende ventana+mezcla
 *  con backtest por market, sin mezclar particiones. Fail-open total. */
export async function tuneModelParams(
  storeId: string,
  opts?: { dryRun?: boolean; nowMs?: number },
): Promise<ModelTuneOutcome> {
  const dryRun = opts?.dryRun === true;
  const nowMs = opts?.nowMs ?? Date.now();
  const fail = (reason: string): ModelTuneOutcome => ({
    wrote: false,
    action: "keep",
    reason,
    partitions: [],
  });
  try {
    if (!isSupabaseConfigured()) return fail("Supabase no configurado: se conserva.");
    const db = getSupabase();
    const profile = await getStoreProfile(storeId).catch(() => null);
    if (!profile) return fail("Sin perfil de tenant: se conserva.");
    const cycleDays = await resolveTenantCycleDays(storeId).catch(() => null);
    const archetype = profile.archetype ?? "b2c_consumible";
    const cycle = cycleDays ?? ARCHETYPES[archetype]?.defaultCycleDays ?? 30;
    const horizon = HORIZON_BY_ARCHETYPE[archetype] ?? 60;
    const sigma0 = SIGMA0_BY_ARCHETYPE[archetype] ?? 0.7;

    const [markets, custRows] = await Promise.all([
      listStoreMarkets(storeId).catch(() => [] as TenantMarket[]),
      db.from("customers").select("id,country").eq("store_id", storeId).then(
        (r) => {
          if (r.error) throw new Error(`Customers read: ${r.error.message}`);
          return (r.data ?? []) as Array<{ id: unknown; country: unknown }>;
        },
        () => [] as Array<{ id: unknown; country: unknown }>,
      ),
    ]);
    const tuneCustomers: TuneCustomer[] = custRows.map((c) => ({
      id: String(c.id),
      country: (c.country as string | null) ?? null,
    }));

    // Throttle 30d POR PARTICIÓN sobre filas de versión SOPORTADA: una fila
    // vieja/inválida (que el lector ignora) no frena el re-tune.
    const fittedByMarket = new Map<string | null, number>();
    try {
      const { data: fits } = await db
        .from("tenant_model_params")
        .select("market_id,fitted_at,version")
        .eq("store_id", storeId)
        .order("fitted_at", { ascending: false })
        .limit(50);
      for (const r of (fits ?? []) as Array<Record<string, unknown>>) {
        const key = (r.market_id as string | null) ?? null;
        if (fittedByMarket.has(key)) continue;
        if (!isSupportedModelParamsVersion(r.version)) continue;
        const t = typeof r.fitted_at === "string" ? Date.parse(r.fitted_at) : NaN;
        if (Number.isFinite(t)) fittedByMarket.set(key, t);
      }
    } catch {
      // Sin estado legible no se frena: se evalúa y el write lo sella.
    }

    const currentParams = await resolveModelParams(storeId).catch(
      () => new Map<string | null, TenantModelParams>(),
    );

    // Historia real completa (como producción); el corte parte en memoria.
    // Incluye market_id por orden: la partición lo necesita.
    const orders: TuneOrder[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("orders")
        .select("customer_id,total_amount,currency,market_id,placed_at,status,payment_status,is_test")
        .eq("store_id", storeId)
        .order("placed_at", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`Orders read: ${error.message}`);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        if (
          !isRealOrder({
            status: (r.status as string | null) ?? null,
            paymentStatus: (r.payment_status as string | null) ?? null,
            isTest: Boolean(r.is_test),
          })
        ) {
          continue;
        }
        const t = Date.parse(String(r.placed_at ?? ""));
        if (Number.isNaN(t)) continue;
        orders.push({
          customerId: String(r.customer_id ?? ""),
          at: t,
          ticketMinor: Number(r.total_amount ?? 0),
          currency: (r.currency as string | null) ?? null,
          marketId: (r.market_id as string | null) ?? null,
        });
      }
      if (!data || data.length < 1000) break;
    }

    const validationH = tuneValidationHorizon(horizon);
    const origins = [1, 2, 3].map((k) => tuneCutoff(nowMs, k * validationH));
    // WFO con partición por origen (P2-2): cada origen se particiona con
    // órdenes ≤ su corte — ni la asignación ni las muestras usan futuro.
    // Sin clientes con compras reales no hay tune.
    const wfoByMarket = evaluateTuneWFO(
      orders,
      tuneCustomers,
      markets,
      origins,
      { cycleDays: cycle, sigma0 },
      (marketId) => {
        const { params: curParams } = paramsForPartition(currentParams, marketId);
        const curMix = curParams?.mixture ? asValidMixtureFit(curParams.mixture) : null;
        return {
          window: curParams?.episodeWindowDays ?? null,
          mixture: curMix,
          hasRow: curParams !== null,
        };
      },
      validationH,
    );
    if (wfoByMarket.size === 0) return fail("Sin clientes con compras reales: se conserva.");

    const partOutcomes: TunePartitionOutcome[] = [];
    const candidateByPart = new Map<string, {
      candidate: NonNullable<TuneDecision["candidate"]>;
      currentWindow: number | null;
      currentK: number;
      currentLogLoss: number;
      bestLogLoss: number | null;
    }>();
    const partKey = (m: string | null): string => (m === null ? "__null__" : m);
    for (const [marketId, wfo] of wfoByMarket) {
      const runOne = (): TunePartitionOutcome => {
        const label = wfo.label;
        const lastMs = fittedByMarket.get(marketId) ?? NaN;
        if (!dryRun && Number.isFinite(lastMs) && nowMs - lastMs < MODEL_TUNE_DAYS * DAY_MS) {
          const days = Math.max(0, Math.round((nowMs - lastMs) / DAY_MS));
          return {
            marketId, label, action: "keep", wrote: false,
            samples: 0, events: 0, window: null, k: null,
            brierCurrent: null, brierCandidate: null,
            reason: `Tuneado hace ${days}d (<${MODEL_TUNE_DAYS}d): se conserva.`,
          };
        }
        const { params: curParams } = paramsForPartition(currentParams, marketId);
        const hasRow = curParams !== null;
        const curMix = curParams?.mixture ? asValidMixtureFit(curParams.mixture) : null;
        const current: TuneCurrent = {
          window: curParams?.episodeWindowDays ?? null,
          mixture: curMix,
          hasRow,
        };
        const currentScores = scoreTuneSamples(wfo.currentPooled);
        const entries: TuneEntry[] = wfo.perWindow.map((pw) => ({
          window: pw.window,
          mixture: pw.mixture,
          scores: scoreTuneSamples(pw.pooled),
          samples: pw.pooled,
        }));
        const decision = decideTune(
          { ...current, scores: currentScores, samples: wfo.currentPooled },
          entries,
          { n: currentScores.n, events: currentScores.events },
          { horizonDays: validationH },
        );
        const bestEntry =
          decision.candidate !== null
            ? entries.find(
                (e) =>
                  e.window === decision.candidate?.window &&
                  (e.mixture?.k ?? 1) === (decision.candidate?.mixture?.k ?? 1),
              ) ?? null
            : null;
        const outcome: TunePartitionOutcome = {
          marketId,
          label: wfo.label,
          action: decision.action,
          wrote: false,
          samples: currentScores.n,
          events: currentScores.events,
          window: decision.candidate?.window ?? current.window,
          k: decision.candidate?.mixture?.k ?? (curMix?.k ?? 1),
          brierCurrent: currentScores.n > 0 ? currentScores.brier : null,
          brierCandidate: bestEntry !== null ? bestEntry.scores.brier : null,
          reason: dryRun && decision.action === "apply" ? `Dry-run: ${decision.reason}` : decision.reason,
        };
        if (decision.candidate !== null) {
          candidateByPart.set(partKey(marketId), {
            candidate: decision.candidate,
            currentWindow: current.window,
            currentK: curMix?.k ?? 1,
            currentLogLoss: currentScores.logLoss,
            bestLogLoss: bestEntry?.scores.logLoss ?? null,
          });
        }
        return outcome;
      };
      const po = runOne();
      if (po.action === "apply" && !dryRun) {
        const ctx = candidateByPart.get(partKey(po.marketId));
        if (ctx !== undefined) {
          // P3-1: escritura por partición con try/catch propio — si una
          // partición falla al escribir, las demás conservan su veredicto
          // y el motivo lo dice en vez de un "omitido" global engañoso.
          try {
            const cand = ctx.candidate;
            const mixture: LearnedMixture | null = cand.mixture
              ? {
                  k: cand.mixture.k,
                  components: cand.mixture.components.map((c) => ({
                    weight: c.weight,
                    mu: c.mu,
                    sigma: c.sigma,
                  })),
                }
              : null;
            const version = mixture !== null ? MIXTURE_VERSION : EPISODE_VERSION;
            await writeModelParams(
              storeId,
              po.marketId,
              { episodeWindowDays: cand.window, mixture },
              version,
              {
                samples: po.samples,
                events: po.events,
                backtest: {
                  method: "wfo-3origins",
                  validation_horizon_days: validationH,
                  production_horizon_days: horizon,
                  market_id: po.marketId,
                  market_label: po.label,
                  origins: origins.map((c) => new Date(c).toISOString()),
                  windows_tried: enumerateTuneWindows(ctx.currentWindow),
                  current: {
                    window: ctx.currentWindow,
                    k: ctx.currentK,
                    brier: po.brierCurrent,
                    log_loss: ctx.currentLogLoss,
                  },
                  candidate: {
                    window: cand.window,
                    k: cand.mixture?.k ?? 1,
                    brier: po.brierCandidate,
                    log_loss: ctx.bestLogLoss,
                  },
                  decision: po.action,
                },
              },
            );
            po.wrote = true;
          } catch (e) {
            po.action = "keep";
            po.reason = `No se pudo persistir (${e instanceof Error ? e.message : "error"}): se conserva.`;
          }
        }
      }
      partOutcomes.push(po);
    }

    const wrote = partOutcomes.some((p) => p.wrote);
    const action: TuneAction = partOutcomes.some((p) => p.action === "apply")
      ? "apply"
      : partOutcomes.some((p) => p.action === "propose")
        ? "propose"
        : "keep";
    return {
      wrote,
      action,
      reason: partOutcomes.map((p) => `[${p.label}] ${p.reason}`).join(" "),
      partitions: partOutcomes,
    };
  } catch (e) {
    return fail(`Tune omitido: ${e instanceof Error ? e.message : "error"}.`);
  }
}
