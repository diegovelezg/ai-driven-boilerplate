// Persistencia del motor probabilístico (issue #5).
// El modelo puro vive en retention-model.ts; aquí solo I/O con Supabase.
import { getSupabase } from "@/lib/supabase";
import { isRealOrder } from "@/lib/medusa";
import {
  ARCHETYPES,
  getStoreProfile,
  resolveBandCuts,
  resolveShopCurrency,
  resolveTenantCycleDays,
} from "@/lib/store-profiles";
import {
  EPISODE_VERSION,
  HORIZON_BY_ARCHETYPE,
  MIXTURE_VERSION,
  SIGMA0_BY_ARCHETYPE,
  asValidMixtureFit,
  episodeize,
  predictStore,
  sessionize,
  type CustomerSessions,
  type MixtureEvidence,
  type MixtureLike,
  type Prediction,
} from "@/lib/retention-model";
import { assignMarket, listStoreMarkets, type TenantMarket } from "@/lib/markets";
import {
  paramsForPartition,
  resolveModelParams,
  type TenantModelParams,
} from "@/lib/model-params";

/** Versión del criterio: se guarda en evidence_json.generator. */
const RETENTION_GEN = "retention:v3:episodes-mixture";
/** model_version para la clave única (store, customer, as_of).
 *  v3 = pipeline con episodios + mezcla (issue #27): en frío produce lo
 *  mismo que v2 (las filas v2 viejas no se reescriben; los lectores
 *  prefieren v3 por orden lexicográfico). */
const RETENTION_VERSION = "retention:v3";

const DAY_MS = 86_400_000;

export interface RetentionSummary {
  predicted: number;
  actuar: number;
  vigilar: number;
  suprimidos: number;
}

interface OrderRow {
  customer_id: string;
  total_amount: number;
  currency: string | null;
  market_id: string | null;
  country: string | null;
  placed_at: string | null;
  status: string | null;
  payment_status: string | null;
  is_test: boolean;
}

/** Tipo efectivo por cliente (misma regla que la GUI): override manual ??
 *  base. Usado para isB2B por lado (issue #21 Paso 4). */
function effectiveType(
  customerType: string | null,
  manualEdits: Record<string, unknown> | null,
): "B2B" | "B2C" {
  const manual =
    manualEdits != null &&
    typeof manualEdits["customer_type"] === "string" &&
    (manualEdits["customer_type"] as string).trim() !== ""
      ? String(manualEdits["customer_type"]).trim().toUpperCase()
      : null;
  const base = (customerType ?? "B2C").trim().toUpperCase();
  return (manual ?? base) === "B2B" ? "B2B" : "B2C";
}

/**
 * Corre el modelo para una tienda y hace upsert en `customer_predictions`.
 * Bulk (sin N+1): una sola query de órdenes por tienda paginada.
 */
export async function runRetentionModel(
  storeId: string,
  asOf = new Date(),
): Promise<RetentionSummary> {
  const db = getSupabase();
  const asOfMs = asOf.getTime();
  // Clave diaria (UTC) para idempotencia: dos corridas el mismo día hacen
  // upsert sobre las mismas filas, sin duplicar.
  const dayIso = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  ).toISOString();
  const asOfIso = dayIso;

  const [profile, cycleDays, shopCurrency, bandCuts, markets, modelParamsByKey] = await Promise.all([
    getStoreProfile(storeId).catch(() => null),
    resolveTenantCycleDays(storeId).catch(() => null),
    resolveShopCurrency(storeId).catch(() => null),
    resolveBandCuts(storeId).catch(() => ({ high: 0.6, low: 0.15 })),
    listStoreMarkets(storeId).catch(() => [] as TenantMarket[]),
    resolveModelParams(storeId).catch(() => new Map<string | null, TenantModelParams>()),
  ]);
  const archetype = profile?.archetype ?? "b2c_consumible";
  const cycle = cycleDays ?? ARCHETYPES[archetype]?.defaultCycleDays ?? 30;
  const horizon = HORIZON_BY_ARCHETYPE[archetype] ?? 60;
  const sigma0 = SIGMA0_BY_ARCHETYPE[archetype] ?? 0.7;
  const isB2B = archetype === "b2b_proyecto" || archetype === "b2b_recurrente";
  const cycleSource: string =
    profile?.repurchaseCycleDays != null ? "tienda" : "arquetipo";
  // Ciclo por market (Paso 3): sin columna por market, el ciclo es el del
  // tenant (tienda → arquetipo) para todas las particiones; la moneda sí es
  // por market (market.currency ⇒ tienda). Documentado, no fitted.

  // --- Clientes en bulk (1.000 por página) ---
  const custRows: Array<{
    id: string;
    email: string | null;
    phone: string | null;
    customerType: string | null;
    manualEdits: Record<string, unknown> | null;
    country: string | null;
  }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("customers")
      .select("id,email,phone,customer_type,manual_edits,country")
      .eq("store_id", storeId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`Customers read: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      custRows.push({
        id: String(r.id),
        email: (r.email as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        customerType: (r.customer_type as string | null) ?? null,
        manualEdits: (r.manual_edits as Record<string, unknown> | null) ?? null,
        country: (r.country as string | null) ?? null,
      });
    }
    if (!data || data.length < 1000) break;
  }
  const custIds = custRows.map((c) => c.id);
  const byId = new Map(custRows.map((c) => [c.id, c]));

  // --- Órdenes reales en bulk (paginado por tienda, agrupado en memoria) ---
  const ordersByCust = new Map<string, OrderRow[]>();
  if (custIds.length > 0) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("orders")
        .select("customer_id,total_amount,currency,market_id,country,placed_at,status,payment_status,is_test")
        .eq("store_id", storeId)
        .order("placed_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`Orders read: ${error.message}`);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const o: OrderRow = {
          customer_id: String(r.customer_id),
          total_amount: Number(r.total_amount ?? 0),
          currency: (r.currency as string | null) ?? null,
          market_id: (r.market_id as string | null) ?? null,
          country: (r.country as string | null) ?? null,
          placed_at: (r.placed_at as string | null) ?? null,
          status: (r.status as string | null) ?? null,
          payment_status: (r.payment_status as string | null) ?? null,
          is_test: Boolean(r.is_test),
        };
        if (
          !isRealOrder({
            status: o.status,
            paymentStatus: o.payment_status,
            isTest: o.is_test,
          })
        )
          continue;
        if (!o.placed_at) continue;
        if (!ordersByCust.has(o.customer_id)) ordersByCust.set(o.customer_id, []);
        ordersByCust.get(o.customer_id)!.push(o);
      }
      if (!rows || rows.length < 1000) break;
    }
  }

  // --- Supresiones ---
  const suppressed = new Map<string, "sin_canal" | "contactado_reciente">();
  for (const c of custRows) {
    const hasEmail = (c.email ?? "").trim() !== "";
    const hasPhone = (c.phone ?? "").trim() !== "";
    if (!hasEmail && !hasPhone) suppressed.set(c.id, "sin_canal");
  }
  const contactWindowDays = Math.min(14, Math.floor(horizon / 2));
  const contactSince = new Date(asOfMs - contactWindowDays * DAY_MS).toISOString();
  const dismissSince = new Date(asOfMs - 30 * DAY_MS).toISOString();
  // Cota superior = fin del día del corte: en backfill (asOf histórico) los
  // envíos/dismiss posteriores al corte no deben suprimir la foto vieja.
  // En corridas normales es no-op (no hay dispatched_at futuro).
  const asOfEndIso = new Date(Date.parse(dayIso) + DAY_MS).toISOString();
  // dispatched_at reciente
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("proposed_actions")
      .select("customer_id,dispatched_at")
      .eq("store_id", storeId)
      .not("dispatched_at", "is", null)
      .gte("dispatched_at", contactSince)
      .lt("dispatched_at", asOfEndIso)
      .order("dispatched_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      // Issue #11: fail-open auditado. Ante error BD se supone "no
      // suprimido" (se contacta de más, no se vacía la cola), pero se
      // deja constancia en vez de break silencioso.
      const { createLogger } = await import("@/lib/log");
      createLogger("retention")(`supresiones dispatched read ERROR ${error.message}`);
      break;
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const cid = String(r.customer_id ?? "");
      if (cid && !suppressed.has(cid)) suppressed.set(cid, "contactado_reciente");
    }
    if (!rows || rows.length < 1000) break;
  }
  // dismissed <30d (closed_at reciente)
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("churn_signals")
      .select("customer_id,closed_at")
      .eq("store_id", storeId)
      .eq("status", "dismissed")
      .gte("closed_at", dismissSince)
      .lt("closed_at", asOfEndIso)
      .order("closed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      const { createLogger } = await import("@/lib/log");
      createLogger("retention")(`supresiones dismissed read ERROR ${error.message}`);
      break;
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const cid = String(r.customer_id ?? "");
      if (cid && !suppressed.has(cid)) suppressed.set(cid, "contactado_reciente");
    }
    if (!rows || rows.length < 1000) break;
  }

  // --- Partición por market (issue #21 Paso 3): asignación única por cliente
  // (mayoría de market_id ⇒ país ⇒ null). Sesiones filtradas a la partición:
  // órdenes de otros markets no informan ritmo/ticket de este (universos
  // separados, nunca PEN+MXN en ningún Σ). Sin órdenes se salta (sin-compras
  // fuera del motor, como en v1).
  const marketById = new Map<string, string | null>();
  const typeById = new Map<string, "B2B" | "B2C">();
  for (const c of custRows) {
    const ords = ordersByCust.get(c.id) ?? [];
    // Solo órdenes ≤ corte para la etiqueta (sin leak de futuro en backtests).
    const mids = ords
      .filter((o) => {
        if (!o.placed_at) return true;
        const t = new Date(o.placed_at).getTime();
        return !Number.isFinite(t) || t <= asOfMs;
      })
      .map((o) => o.market_id);
    marketById.set(c.id, assignMarket(mids, c.country, markets));
    typeById.set(c.id, effectiveType(c.customerType, c.manualEdits));
  }
  const partCustomers = new Map<string | null, CustomerSessions[]>();
  const gapsById = new Map<string, number>();
  const tById = new Map<string, number>();
  const episodesById = new Map<string, number>();
  const paramsSourceById = new Map<string, "tienda:market" | "tienda:global" | "arquetipo">();
  const episodeWindowById = new Map<string, number | null>();
  for (const c of custRows) {
    const assigned = marketById.get(c.id) ?? null;
    const ords = ordersByCust.get(c.id) ?? [];
    const inPart = assigned === null
      ? ords
      : ords.filter((o) => o.market_id === null || o.market_id === assigned);
    const parsed = inPart
      .map((o) => {
        const d = o.placed_at ? new Date(o.placed_at) : null;
        return d && !Number.isNaN(d.getTime())
          ? { placedAt: d.getTime(), ticketMinor: o.total_amount, currency: o.currency }
          : null;
      })
      .filter((x): x is { placedAt: number; ticketMinor: number; currency: string | null } => x !== null)
      // Solo órdenes hasta el corte (para backtest con asOf histórico).
      .filter((x) => x.placedAt <= asOfMs);
    const sessions = sessionize(parsed);
    if (sessions.length === 0) continue;
    const cs: CustomerSessions = {
      customerId: c.id,
      sessions,
      marketId: assigned,
      customerType: typeById.get(c.id) ?? "B2C",
    };
    const list = partCustomers.get(assigned) ?? [];
    list.push(cs);
    partCustomers.set(assigned, list);
    // Evidencia para el upsert (issue #27 Pasos 1+3): episodios con la ventana
    // aprendida de la partición; en frío (sin fila) cada sesión = 1 episodio
    // ⇒ idéntico a v2. La mezcla la aplica predictStore con el fit explícito.
    const { params: custParams, source: custSource } = paramsForPartition(
      modelParamsByKey,
      assigned,
    );
    const custWindow = custParams?.episodeWindowDays ?? null;
    paramsSourceById.set(c.id, custSource);
    episodeWindowById.set(c.id, custWindow);
    const episodes = episodeize(sessions, custWindow, null);
    episodesById.set(c.id, episodes.length);
    let gaps = 0;
    for (let i = 1; i < episodes.length; i += 1) {
      if ((episodes[i].startAt - episodes[i - 1].endAt) / DAY_MS > 0) gaps += 1;
    }
    gapsById.set(c.id, gaps);
    const last = episodes[episodes.length - 1].endAt;
    tById.set(c.id, Math.max(0, (asOfMs - last) / DAY_MS));
  }

  // --- Una corrida por partición: moneda/grillas/cura/deciles propios por
  // market; ciclo del tenant en todas (sin columna por market: fallback
  // tienda → arquetipo documentado). Bandas por tenant (Paso 5).
  const marketByMarketId = new Map(markets.map((m) => [m.id, m]));
  const preds: Prediction[] = [];
  const currencyById = new Map<string, string | null>();
  // Mezcla desactivada salvo parámetros aprendidos (issue #27 Pasos 3-4):
  // sin fila vigente ⇒ fits null ⇒ camino legacy exacto. La mezcla
  // aprendida (mismo fit para ambos niveles en v1) es estable entre tunes:
  // la predicción diaria NO reajusta. Su aplicación la arbitra el tune con
  // backtest (Paso 4); aquí solo lectura fail-open.
  // (Un ajuste por partición y nivel: renovación usa store, F=1 cohorte.)
  const mixtureByPart = new Map<string | null, MixtureEvidence>();
  for (const [partId, customers] of partCustomers) {
    const market = partId === null ? null : (marketByMarketId.get(partId) ?? null);
    const partCurrency = (market?.currency ?? shopCurrency ?? null) as string | null;
    for (const cs of customers) currencyById.set(cs.customerId, partCurrency);
    const partMixture: MixtureEvidence = {};
    const { params: partParams } = paramsForPartition(modelParamsByKey, partId);
    // Fit aprendido por partición (v1: mismo para tienda y cohorte);
    // null/inválido ⇒ legacy o EM al vuelo (EM apagado: mixtureMaxK null).
    const learnedFit: MixtureLike | null =
      partParams?.mixture ? asValidMixtureFit(partParams.mixture) : null;
    const part = predictStore({
      asOf: asOfMs,
      cycleDays: cycle,
      horizonDays: horizon,
      sigma0,
      shopCurrency: partCurrency,
      customers,
      suppressed,
      isB2B,
      marketId: partId,
      bandHigh: bandCuts.high,
      bandLow: bandCuts.low,
      episodeGapDays: partParams?.episodeWindowDays ?? null,
      mixtureMaxK: null,
      mixtureStoreFit: learnedFit,
      mixtureCohortFit: learnedFit,
      mixtureEvidence: partMixture,
    });
    mixtureByPart.set(partId, partMixture);
    preds.push(...part);
  }

  // --- Upsert en lotes de 500 ---
  // DEPLOY (issue #21, bloqueante): aplicar antes del primer run v2, en orden:
  //   20261025000000_close_watch_p, 20261026000000_customer_predictions_market,
  //   20261026000001_store_band_cuts.
  // El upsert incluye `market_id` sin guarda (fail-closed como ejes #14A):
  // sin la migración la corrida falla entera. Los resolvers sí son fail-open.
  const rows = preds.map((p) => {
    // Nivel de mezcla por modelo (issue #27 Paso 2): renovación ⇒ store,
    // segunda_compra ⇒ cohorte. Null cuando la mezcla está desactivada.
    const partMix = mixtureByPart.get(p.marketId);
    const levelFit = p.model === "renovacion" ? partMix?.store : partMix?.cohort;
    const fit = levelFit !== undefined ? levelFit : null;
    return {
    store_id: storeId,
    customer_id: p.customerId,
    market_id: p.marketId,
    as_of: asOfIso,
    model_version: RETENTION_VERSION,
    model: p.model,
    p_recompra_h: p.pRecompraH,
    p_low: p.pLow,
    p_high: p.pHigh,
    horizon_days: horizon,
    expected_days: p.expectedDays,
    p25_days: p.p25Days,
    p75_days: p.p75Days,
    ticket_esperado_minor: p.ticketEsperadoMinor,
    valor_esperado_minor: p.valorEsperadoMinor,
    currency: currencyById.get(p.customerId) ?? shopCurrency,
    decision: p.decision,
    confidence: p.confidence,
    ritmo: p.ritmo,
    ventana: p.ventana,
    banda_p: p.bandaP,
    valor_decil: p.valorDecil,
    elegibilidad: p.elegibilidad,
    decision_version: p.decisionVersion,
    evidence_json: {
      gaps: gapsById.get(p.customerId) ?? 0,
      t_days: Math.round((tById.get(p.customerId) ?? 0) * 10) / 10,
      cycle_days: cycle,
      cycle_source: cycleSource,
      generator: RETENTION_GEN,
      market_id: p.marketId,
      customer_type: typeById.get(p.customerId) ?? null,
      band_high: bandCuts.high,
      band_low: bandCuts.low,
      episodes: episodesById.get(p.customerId) ?? 0,
      episode_version: EPISODE_VERSION,
      episode_window_days: episodeWindowById.get(p.customerId) ?? null,
      model_params_source: paramsSourceById.get(p.customerId) ?? "arquetipo",
      mixture_k: fit !== null && fit !== undefined ? fit.k : null,
      mixture_weights: fit !== null && fit !== undefined
        ? fit.components.map((c) => Math.round(c.weight * 1000) / 1000)
        : null,
      mixture_version: fit !== null && fit !== undefined ? MIXTURE_VERSION : null,
      mixture_resp: partMix?.respById?.get(p.customerId)?.map((r) => Math.round(r * 1000) / 1000) ?? null,
      // Medianas en días por componente (Paso 5.1: sustento humano sin jerga;
      // `describeCustomerRhythm` las lee de aquí, nunca μ/σ/pesos crudos).
      mixture_meds: fit !== null && fit !== undefined
        ? fit.components.map((c) => Math.max(1, Math.round(Math.exp(c.mu))))
        : null,
    },
  };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await db
      .from("customer_predictions")
      .upsert(batch, { onConflict: "store_id,customer_id,as_of,model_version" });
    if (error) throw new Error(`Predictions upsert: ${error.message}`);
  }

  let actuar = 0;
  let vigilar = 0;
  let suprimidos = 0;
  for (const p of preds) {
    if (p.decision === "actuar" || p.decision === "revision_humana") actuar += 1;
    else if (p.decision === "vigilar") vigilar += 1;
    else suprimidos += 1;
  }
  // Contactado/sin_canal sin sesiones no generan predicción: se cuentan aparte.
  void byId;
  return { predicted: preds.length, actuar, vigilar, suprimidos };
}
