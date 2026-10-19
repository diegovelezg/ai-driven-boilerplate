// Backtest y calibración del motor retention:v1 (issue #5, Paso 5).
// Rolling-origin con solo órdenes ≤ corte; excluye H no madurado.
// Uso: npx tsx --env-file=.env.local scripts/calibrate-retention.ts
// Salida: consola + JSON en .data/calibrate-retention.json (no UI).
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { isRealOrder } from "@/lib/medusa";
import { ARCHETYPES, getStoreProfile } from "@/lib/store-profiles";
import {
  HORIZON_BY_ARCHETYPE,
  SIGMA0_BY_ARCHETYPE,
  predictStore,
  sessionize,
} from "@/lib/retention-model";

const DAY_MS = 86_400_000;

async function main() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const medusaUrl = String(
    JSON.parse(readFileSync(".data/connections.json", "utf-8")).medusaUrl,
  ).replace(/\/+$/, "");
  const { data: store } = await db.from("stores").select("id").eq("shop_url", medusaUrl).maybeSingle();
  if (!store) throw new Error("Sin store para esta conexión.");
  const storeId = store.id as string;
  const profile = await getStoreProfile(storeId);
  const archetype = profile?.archetype ?? "b2c_consumible";
  const cycle = profile?.repurchaseCycleDays ?? ARCHETYPES[archetype].defaultCycleDays;
  const H = HORIZON_BY_ARCHETYPE[archetype] ?? 60;
  const sigma0 = SIGMA0_BY_ARCHETYPE[archetype] ?? 0.7;
  const isB2B = archetype === "b2b_proyecto" || archetype === "b2b_recurrente";
  const { data: shop } = await db.from("stores").select("shop_currency").eq("id", storeId).maybeSingle();
  const shopCurrency = (shop?.shop_currency as string | null) ?? null;
  console.log(`perfil: archetype=${archetype} cycle=${cycle} H=${H} sigma0=${sigma0} shop=${shopCurrency}`);

  // Bulk: clientes + órdenes reales.
  const { data: custRows } = await db
    .from("customers")
    .select("id")
    .eq("store_id", storeId)
    .limit(5000);
  const custIds = ((custRows ?? []) as Array<{ id: string }>).map((c) => c.id);
  const orders: Array<{ customer_id: string; at: number }> = [];
  for (let i = 0; i < custIds.length; i += 200) {
    const { data } = await db
      .from("orders")
      .select("customer_id,placed_at,status,payment_status,is_test")
      .in("customer_id", custIds.slice(i, i + 200))
      .order("placed_at", { ascending: true });
    for (const o of (data ?? []) as Array<Record<string, unknown>>) {
      if (
        !isRealOrder({
          status: (o.status as string) ?? null,
          paymentStatus: (o.payment_status as string) ?? null,
          isTest: Boolean(o.is_test),
        })
      )
        continue;
      if (!o.placed_at) continue;
      const d = new Date(o.placed_at as string);
      if (Number.isNaN(d.getTime())) continue;
      orders.push({ customer_id: o.customer_id as string, at: d.getTime() });
    }
  }
  // Órdenes con ticket/moneda para el modelo (ticket no afecta calibración de p, pero se necesita).
  const ordersFull: Array<{
    customer_id: string;
    at: number;
    ticketMinor: number;
    currency: string | null;
  }> = [];
  for (let i = 0; i < custIds.length; i += 200) {
    const { data } = await db
      .from("orders")
      .select("customer_id,placed_at,total_amount,currency,status,payment_status,is_test")
      .in("customer_id", custIds.slice(i, i + 200))
      .order("placed_at", { ascending: true });
    for (const o of (data ?? []) as Array<Record<string, unknown>>) {
      if (
        !isRealOrder({
          status: (o.status as string) ?? null,
          paymentStatus: (o.payment_status as string) ?? null,
          isTest: Boolean(o.is_test),
        })
      )
        continue;
      if (!o.placed_at) continue;
      const d = new Date(o.placed_at as string);
      if (Number.isNaN(d.getTime())) continue;
      ordersFull.push({
        customer_id: o.customer_id as string,
        at: d.getTime(),
        ticketMinor: Number(o.total_amount ?? 0),
        currency: (o.currency as string | null) ?? null,
      });
    }
  }
  const byCustFull = new Map<string, typeof ordersFull>();
  for (const o of ordersFull) {
    if (!byCustFull.has(o.customer_id)) byCustFull.set(o.customer_id, []);
    byCustFull.get(o.customer_id)!.push(o);
  }
  const byCustTimes = new Map<string, number[]>();
  for (const o of orders) {
    if (!byCustTimes.has(o.customer_id)) byCustTimes.set(o.customer_id, []);
    byCustTimes.get(o.customer_id)!.push(o.at);
  }

  const now = Date.now();
  // Cortes no solapados (issue #10 P2): paso = H para que las ventanas
  // (corte, corte+H] sean independientes. Antes cada 15d con H=90d solapaba
  // 6x y contaba el mismo evento varias veces.
  // Nota leakage documentado: se usa el perfil/ciclo ACTUAL en todos los
  // cortes (no hay snapshots históricos de store_profiles). Si el ciclo
  // declarado cambió, los cortes viejos heredan el nuevo — ver campo
  // cicloFuente en el JSON.
  const step = Math.max(15, H);
  const cutoffs = [0, 1, 2, 3, 4, 5].map((k) => now - H * DAY_MS - k * step * DAY_MS);
  const pairs: Array<{ p: number; pLow: number; pHigh: number; y: number; model: string }> = [];
  let nPred = 0;
  for (const cutoff of cutoffs) {
    const customers = [];
    // Sesiones completas (toda la historia) para la etiqueta y por SESIONES
    // (issue #10 P2: pago partido = 1 compra, no N órdenes).
    const sessionsByCust = new Map<string, Array<{ at: number }>>();
    for (const cid of custIds) {
      const ords = (byCustFull.get(cid) ?? []).filter((o) => o.at <= cutoff);
      if (ords.length === 0) continue;
      const sessions = sessionize(
        ords.map((o) => ({ placedAt: o.at, ticketMinor: o.ticketMinor, currency: o.currency })),
      );
      if (sessions.length === 0) continue;
      customers.push({ customerId: cid, sessions });
    }
    for (const cid of custIds) {
      const allOrds = byCustFull.get(cid) ?? [];
      if (allOrds.length === 0) continue;
      sessionsByCust.set(
        cid,
        sessionize(allOrds.map((o) => ({ placedAt: o.at, ticketMinor: o.ticketMinor, currency: o.currency }))),
      );
    }
    if (customers.length === 0) continue;
    const preds = predictStore({
      asOf: cutoff,
      cycleDays: cycle,
      horizonDays: H,
      sigma0,
      shopCurrency,
      customers,
      suppressed: new Map(),
      isB2B,
    });
    nPred += preds.length;
    for (const p of preds) {
      const sessions = sessionsByCust.get(p.customerId) ?? [];
      const y = sessions.some((s) => s.at > cutoff && s.at <= cutoff + H * DAY_MS) ? 1 : 0;
      pairs.push({ p: p.pRecompraH, pLow: p.pLow, pHigh: p.pHigh, y, model: p.model });
    }
    console.log(
      `corte ${new Date(cutoff).toISOString().slice(0, 10)}: clientes=${customers.length} preds=${preds.length}`,
    );
  }

  const n = pairs.length;
  const events = pairs.filter((x) => x.y === 1).length;
  const brier = n > 0 ? pairs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / n : null;
  const meanP = n > 0 ? pairs.reduce((a, x) => a + x.p, 0) / n : null;
  const obsRate = n > 0 ? events / n : null;
  // Calibración por deciles de p + cobertura de intervalos (issue #10 P2:
  // antes sin cobertura) + desglose por modelo A/B (issue #12).
  const buildDecis = (rows: typeof pairs) => {
    const decis: Array<{ decil: string; n: number; predicho: number; observado: number; cubierto: boolean }> = [];
    for (let d = 0; d < 10; d += 1) {
      const lo = d / 10;
      const hi = (d + 1) / 10;
      const bin = rows.filter((x) => (d === 9 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi));
      const predicho = bin.length > 0 ? bin.reduce((a, x) => a + x.p, 0) / bin.length : 0;
      const observado = bin.length > 0 ? bin.filter((x) => x.y === 1).length / bin.length : 0;
      const lowMean = bin.length > 0 ? bin.reduce((a, x) => a + x.pLow, 0) / bin.length : 0;
      const highMean = bin.length > 0 ? bin.reduce((a, x) => a + x.pHigh, 0) / bin.length : 0;
      decis.push({ decil: `${lo.toFixed(1)}–${hi.toFixed(1)}`, n: bin.length, predicho, observado, cubierto: observado >= lowMean - 0.05 && observado <= highMean + 0.05 });
    }
    return decis;
  };
  const decis = buildDecis(pairs);
  const decisA = buildDecis(pairs.filter((x) => x.model === "renovacion"));
  const decisB = buildDecis(pairs.filter((x) => x.model === "segunda_compra"));
  // KM observada vs media predicha (único uso permitido de KM: diagnóstico).
  // KM(t) = fracción sin compra hasta t; predicha media = 1 - mean(p) en H.
  const kmObsH = n > 0 ? 1 - obsRate! : null;
  const kmPredH = meanP !== null ? 1 - meanP : null;
  const out = {
    store_id: storeId,
    archetype,
    cycleDays: cycle,
    cicloFuente: "actual (sin snapshots históricos: los cortes viejos heredan el ciclo declarado hoy)",
    horizonDays: H,
    pasoCortesDias: step,
    cutoffs: cutoffs.map((c) => new Date(c).toISOString()),
    nPredicciones: nPred,
    n,
    eventos: events,
    brier,
    meanPredicho: meanP,
    observadoGlobal: obsRate,
    porDecil: decis,
    porDecilRenovacion: decisA,
    porDecilSegundaCompra: decisB,
    coberturaDeciles: decis.filter((d) => d.n > 0 && d.cubierto).length,
    km: { observadaSinCompraH: kmObsH, predichaMediaSinCompraH: kmPredH },
    nota: "Aceptación: en deciles centrales el observado cae dentro del predicho ±10pp en la cohorte agregada; si no, ajustar sigma0/k y repetir.",
  };
  console.log(`predicciones=${nPred} eventos=${events}/${n} brier=${brier?.toFixed(4)}`);
  console.table(decis);
  console.log(`KM observada sin compra en H: ${kmObsH?.toFixed(3)} vs predicha media: ${kmPredH?.toFixed(3)}`);
  writeFileSync(".data/calibrate-retention.json", JSON.stringify(out, null, 2));
  console.log("JSON en .data/calibrate-retention.json");
}

main().catch((e) => {
  console.error("CALIBRATE FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
