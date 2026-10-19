// Persistencia del motor probabilístico (issue #5).
// El modelo puro vive en retention-model.ts; aquí solo I/O con Supabase.
import { getSupabase } from "@/lib/supabase";
import { isRealOrder } from "@/lib/medusa";
import {
  ARCHETYPES,
  getStoreProfile,
  resolveShopCurrency,
  resolveTenantCycleDays,
} from "@/lib/store-profiles";
import {
  HORIZON_BY_ARCHETYPE,
  SIGMA0_BY_ARCHETYPE,
  predictStore,
  sessionize,
  type CustomerSessions,
} from "@/lib/retention-model";

/** Versión del criterio: se guarda en evidence_json.generator. */
const RETENTION_GEN = "retention:v1:lognormal-grid";
/** model_version para la clave única (store, customer, as_of). */
const RETENTION_VERSION = "retention:v1";

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
  placed_at: string | null;
  status: string | null;
  payment_status: string | null;
  is_test: boolean;
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

  const [profile, cycleDays, shopCurrency] = await Promise.all([
    getStoreProfile(storeId).catch(() => null),
    resolveTenantCycleDays(storeId).catch(() => null),
    resolveShopCurrency(storeId).catch(() => null),
  ]);
  const archetype = profile?.archetype ?? "b2c_consumible";
  const cycle = cycleDays ?? ARCHETYPES[archetype]?.defaultCycleDays ?? 30;
  const horizon = HORIZON_BY_ARCHETYPE[archetype] ?? 60;
  const sigma0 = SIGMA0_BY_ARCHETYPE[archetype] ?? 0.7;
  const isB2B = archetype === "b2b_proyecto" || archetype === "b2b_recurrente";
  const cycleSource: string =
    profile?.repurchaseCycleDays != null ? "tienda" : "arquetipo";

  // --- Clientes en bulk (1.000 por página) ---
  const custRows: Array<{
    id: string;
    email: string | null;
    phone: string | null;
  }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("customers")
      .select("id,email,phone")
      .eq("store_id", storeId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`Customers read: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      custRows.push({
        id: String(r.id),
        email: (r.email as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
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
        .select("customer_id,total_amount,currency,placed_at,status,payment_status,is_test")
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
  // dispatched_at reciente
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("proposed_actions")
      .select("customer_id,dispatched_at")
      .eq("store_id", storeId)
      .not("dispatched_at", "is", null)
      .gte("dispatched_at", contactSince)
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

  // --- Sesiones por cliente (fechas sí cuentan siempre; moneda se filtra dentro) ---
  const customers: CustomerSessions[] = [];
  const gapsById = new Map<string, number>();
  const tById = new Map<string, number>();
  for (const c of custRows) {
    const ords = ordersByCust.get(c.id) ?? [];
    const parsed = ords
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
    customers.push({ customerId: c.id, sessions });
    // Evidencia para el upsert.
    let gaps = 0;
    for (let i = 1; i < sessions.length; i += 1) {
      if ((sessions[i].at - sessions[i - 1].at) / DAY_MS > 0) gaps += 1;
    }
    gapsById.set(c.id, gaps);
    const last = sessions[sessions.length - 1].at;
    tById.set(c.id, Math.max(0, (asOfMs - last) / DAY_MS));
  }

  const preds = predictStore({
    asOf: asOfMs,
    cycleDays: cycle,
    horizonDays: horizon,
    sigma0,
    shopCurrency,
    customers,
    suppressed,
    isB2B,
  });

  // --- Upsert en lotes de 500 ---
  const rows = preds.map((p) => ({
    store_id: storeId,
    customer_id: p.customerId,
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
    currency: shopCurrency,
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
    },
  }));
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
