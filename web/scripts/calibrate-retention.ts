// Backtest y calibración del motor retention:v2 (issue #5, Paso 5; paridad v2 market+b2b+bandas).
// Rolling-origin con solo órdenes ≤ corte; excluye H no madurado.
// Uso: npx tsx --env-file=.env.local scripts/calibrate-retention.ts
// Salida: consola + JSON en .data/calibrate-retention.json (no UI).
import { writeFileSync } from "node:fs";
import { isRealOrder } from "@/lib/canonical";
import { ARCHETYPES, getStoreProfile } from "@/lib/store-profiles";
import { BAND_CUTS_BY_ARCHETYPE } from "@/lib/store-profile-defs";
import {
  HORIZON_BY_ARCHETYPE,
  SIGMA0_BY_ARCHETYPE,
  predictStore,
  sessionize,
} from "@/lib/retention-model";
import { fail, loadServiceStore } from "./lib/run-once";

const DAY_MS = 86_400_000;

async function main() {
  const { db, storeId } = await loadServiceStore();
  const profile = await getStoreProfile(storeId);
  const archetype = profile?.archetype ?? "b2c_consumible";
  const cycle = profile?.repurchaseCycleDays ?? ARCHETYPES[archetype].defaultCycleDays;
  const H = HORIZON_BY_ARCHETYPE[archetype] ?? 60;
  const sigma0 = SIGMA0_BY_ARCHETYPE[archetype] ?? 0.7;
  const isB2B = archetype === "b2b_proyecto" || archetype === "b2b_recurrente";
  const { data: shop } = await db.from("stores").select("shop_currency").eq("id", storeId).maybeSingle();
  const shopCurrency = (shop?.shop_currency as string | null) ?? null;
  // Bandas por tenant (paridad v2 Paso 5): store_profiles.p_band_* o default arquetipo.
  const { data: bandRow } = await db.from("store_profiles").select("p_band_high,p_band_low").eq("store_id", storeId).maybeSingle();
  const dfltBands = BAND_CUTS_BY_ARCHETYPE[archetype] ?? { high: 0.6, low: 0.15 };
  const bandRaw = (bandRow as Record<string, unknown> | null) ?? null;
  const bhRaw = bandRaw?.p_band_high == null ? NaN : Number(bandRaw.p_band_high);
  const blRaw = bandRaw?.p_band_low == null ? NaN : Number(bandRaw.p_band_low);
  const bandHigh = Number.isFinite(bhRaw) && (bhRaw as number) > 0 && (bhRaw as number) < 1 ? (bhRaw as number) : dfltBands.high;
  const bandLow = Number.isFinite(blRaw) && (blRaw as number) >= 0 && (blRaw as number) < 1 ? (blRaw as number) : dfltBands.low;
  const [effHigh, effLow] = bandHigh > bandLow ? [bandHigh, bandLow] : [dfltBands.high, dfltBands.low];
  // Single-país: una sola moneda (la de la tienda), sin particiones.
  console.log(`perfil: archetype=${archetype} cycle=${cycle} H=${H} sigma0=${sigma0} shop=${shopCurrency} bands=${effHigh}/${effLow}`);

  // Bulk: clientes (con tipo efectivo + país para partición v2) + órdenes reales.
  const { data: custRows } = await db
    .from("customers")
    .select("id,customer_type,manual_edits,country")
    .eq("store_id", storeId)
    .limit(5000);
  const custIds = ((custRows ?? []) as Array<{ id: string }>).map((c) => c.id);
  const custMeta = new Map(
    ((custRows ?? []) as Array<Record<string, unknown>>).map((c) => {
      const manual = (c.manual_edits as Record<string, unknown> | null)?.customer_type;
      const eff =
        typeof manual === "string" && manual.trim() !== ""
          ? String(manual).trim().toUpperCase()
          : String((c.customer_type as string | null) ?? "B2C").trim().toUpperCase();
      return [
        String(c.id),
        { customerType: "B2B", country: ((c.country as string | null) ?? null) as string | null },
      ];
    }),
  );
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
  const pairs: Array<{ p: number; pLow: number; pHigh: number; y: number; model: string; decision: string }> = [];
  let nPred = 0;
  for (const cutoff of cutoffs) {
    // Sesiones completas (toda la historia) para la etiqueta y por SESIONES
    // (pago partido = 1 compra, no N órdenes).
    const sessionsByCust = new Map<string, Array<{ at: number }>>();
    // Single-país: un solo universo (toda la tienda), sin particiones.
    const allCustomers: Array<{ customerId: string; sessions: Array<{ at: number; ticketMinor: number; currency: string | null }>; marketId: string | null; customerType: string }> = [];
    for (const cid of custIds) {
      const allOrds = byCustFull.get(cid) ?? [];
      if (allOrds.length === 0) continue;
      sessionsByCust.set(
        cid,
        sessionize(allOrds.map((o) => ({ placedAt: o.at, ticketMinor: o.ticketMinor, currency: o.currency }))),
      );
      const meta = custMeta.get(cid) ?? { customerType: "B2B", country: null };
      const ordsCut = allOrds.filter((o) => o.at <= cutoff);
      if (ordsCut.length === 0) continue;
      const sessions = sessionize(
        ordsCut.map((o) => ({ placedAt: o.at, ticketMinor: o.ticketMinor, currency: o.currency })),
      );
      if (sessions.length === 0) continue;
      allCustomers.push({ customerId: cid, sessions, marketId: null, customerType: meta.customerType });
    }
    if (allCustomers.length === 0) continue;
    let nCut = 0;
    {
      const partCurrency = shopCurrency ?? null;
      const preds = predictStore({
        asOf: cutoff,
        cycleDays: cycle,
        horizonDays: H,
        sigma0,
        shopCurrency: partCurrency,
        customers: allCustomers,
        suppressed: new Map(),
        isB2B,
        marketId: null,
        bandHigh: effHigh,
        bandLow: effLow,
      });
      nPred += preds.length;
      nCut += preds.length;
      for (const p of preds) {
        const sessions = sessionsByCust.get(p.customerId) ?? [];
        const y = sessions.some((s) => s.at > cutoff && s.at <= cutoff + H * DAY_MS) ? 1 : 0;
        pairs.push({ p: p.pRecompraH, pLow: p.pLow, pHigh: p.pHigh, y, model: p.model, decision: p.decision });
      }
    }
    console.log(
      `corte ${new Date(cutoff).toISOString().slice(0, 10)}: preds=${nCut}`,
    );
  }

  const n = pairs.length;
  const events = pairs.filter((x) => x.y === 1).length;
  const brier = n > 0 ? pairs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / n : null;
  const meanP = n > 0 ? pairs.reduce((a, x) => a + x.p, 0) / n : null;
  const obsRate = n > 0 ? events / n : null;
  // Calibración por deciles de p + cobertura de intervalos (issue #10 P2:
  // antes sin cobertura) + desglose por modelo A/B (issue #12).
  // Analista: cada decil lleva IC95% Wilson del observado (con 39 eventos
  // el top tiene ±25pp: "aceptada" = sin evidencia de desastre, no probada).
  const wilson = (k: number, n: number): [number, number] => {
    if (n === 0) return [0, 0];
    const z = 1.96;
    const p = k / n;
    const den = 1 + (z * z) / n;
    const c = p + (z * z) / 2 / n;
    const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / 4 / n / n);
    return [Math.max(0, (c - m) / den), Math.min(1, (c + m) / den)];
  };
  const buildDecis = (rows: typeof pairs) => {
    const decis: Array<{ decil: string; n: number; predicho: number; observado: number; lift: number | null; cubierto: boolean; nEventos: number; ic95: [number, number] }> = [];
    for (let d = 0; d < 10; d += 1) {
      const lo = d / 10;
      const hi = (d + 1) / 10;
      const bin = rows.filter((x) => (d === 9 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi));
      const predicho = bin.length > 0 ? bin.reduce((a, x) => a + x.p, 0) / bin.length : 0;
      const k = bin.filter((x) => x.y === 1).length;
      const observado = bin.length > 0 ? k / bin.length : 0;
      const lowMean = bin.length > 0 ? bin.reduce((a, x) => a + x.pLow, 0) / bin.length : 0;
      const highMean = bin.length > 0 ? bin.reduce((a, x) => a + x.pHigh, 0) / bin.length : 0;
      decis.push({ decil: `${lo.toFixed(1)}–${hi.toFixed(1)}`, n: bin.length, predicho, observado, lift: obsRate && obsRate > 0 && bin.length > 0 ? observado / obsRate : null, cubierto: observado >= lowMean - 0.05 && observado <= highMean + 0.05, nEventos: k, ic95: wilson(k, bin.length) });
    }
    return decis;
  };
  const decis = buildDecis(pairs);
  const decisA = buildDecis(pairs.filter((x) => x.model === "renovacion"));
  const decisB = buildDecis(pairs.filter((x) => x.model === "segunda_compra"));
  // Decisión del motor: ¿actuar/vigilar separan retorno? (curva decisión-realidad).
  const decisionStats = (() => {
    const keys = ["actuar", "vigilar", "organico", "dormido", "sin_canal", "contactado_reciente", "revision_humana"];
    return keys.map((dec) => {
      const rows = pairs.filter((x) => x.decision === dec);
      const k = rows.filter((x) => x.y === 1).length;
      return {
        decision: dec,
        n: rows.length,
        eventos: k,
        observado: rows.length > 0 ? k / rows.length : 0,
        lift: obsRate && obsRate > 0 && rows.length > 0 ? (k / rows.length) / obsRate : null,
        meanP: rows.length > 0 ? rows.reduce((a, x) => a + x.p, 0) / rows.length : 0,
      };
    }).filter((d) => d.n > 0);
  })();
  // Corte p óptimo (Youden J) como proxy de bandLow: el que mejor separa retornos.
  const optimalCut = (() => {
    const cands = [...new Set(pairs.map((x) => x.p))].sort((a, b) => a - b);
    const pos = pairs.filter((x) => x.y === 1).length;
    const neg = pairs.length - pos;
    if (pos < 5 || neg < 5) return null;
    let best: number | null = null;
    let bestJ = 0;
    for (const c of cands) {
      const tp = pairs.filter((x) => x.y === 1 && x.p >= c).length;
      const fp = pairs.filter((x) => x.y === 0 && x.p >= c).length;
      const j = tp / pos + (neg - fp) / neg - 1;
      if (j > bestJ + 1e-9) {
        bestJ = j;
        best = c;
      }
    }
    return best === null ? null : { cut: Math.round(best * 100) / 100, youdenJ: Math.round(bestJ * 1000) / 1000 };
  })();
  const maxP = pairs.length > 0 ? Math.max(...pairs.map((x) => x.p)) : 0;
  // KM observada vs media predicha (único uso permitido de KM: diagnóstico).
  // KM(t) = fracción sin compra hasta t; predicha media = 1 - mean(p) en H.
  const kmObsH = n > 0 ? 1 - obsRate! : null;
  const kmPredH = meanP !== null ? 1 - meanP : null;
  // Skill vs predictor ingenuo (tasa base global): cuánto del Brier elimina
  // el modelo. Sin esta línea el Brier solo no dice si hay predictibilidad.
  const brierNaive = obsRate !== null ? obsRate * (1 - obsRate) : null;
  const skill = brier !== null && brierNaive !== null && brierNaive > 0 ? 1 - brier / brierNaive : null;
  const out = {
    store_id: storeId,
    archetype,
    cycleDays: cycle,
    cicloFuente: "actual (sin snapshots históricos: los cortes viejos heredan el ciclo declarado hoy)",
    horizonDays: H,
    sigma0,
    bandHigh: effHigh,
    bandLow: effLow,
    engine: "retention:v2:lognormal-grid-market-b2b",
    pasoCortesDias: step,
    cutoffs: cutoffs.map((c) => new Date(c).toISOString()),
    nPredicciones: nPred,
    n,
    eventos: events,
    brier,
    brierNaive,
    skillVsNaive: skill,
    meanPredicho: meanP,
    observadoGlobal: obsRate,
    maxP,
    porDecil: decis,
    porDecilRenovacion: decisA,
    porDecilSegundaCompra: decisB,
    porDecision: decisionStats,
    corteOptimoYouden: optimalCut,
    coberturaDeciles: decis.filter((d) => d.n > 0 && d.cubierto).length,
    km: { observadaSinCompraH: kmObsH, predichaMediaSinCompraH: kmPredH },
    nota: "Aceptación: en deciles centrales el observado cae dentro del predicho ±10pp en la cohorte agregada. Con pocos eventos el ±10pp es más estricto que el ruido (ver ic95 por decil): un fallo aislado NO autoriza tocar sigma0/k — se requieren 2 corridas consecutivas fuera de tolerancia o evidencia pooled. Si maxP<bandHigh, organico-probable nunca dispara: bajar bandHigh al entorno de maxP o del corte Youden.",
  };
  console.log(`predicciones=${nPred} eventos=${events}/${n} brier=${brier?.toFixed(4)} naive=${brierNaive?.toFixed(4)} skill=${skill !== null ? (skill * 100).toFixed(1) + "%" : "n/a"} maxP=${maxP.toFixed(3)}`);
  console.table(decis);
  console.table(decisionStats);
  if (optimalCut) console.log(`corte Youden p>=${optimalCut.cut} J=${optimalCut.youdenJ} (bandLow actual ${effLow}, bandHigh actual ${effHigh})`);
  else console.log(`sin corte Youden (poca historia). bandLow ${effLow}, bandHigh ${effHigh}.`);
  writeFileSync(".data/calibrate-retention.json", JSON.stringify(out, null, 2));
  console.log("JSON en .data/calibrate-retention.json");
}

main().catch((e) => {
  fail("CALIBRATE", e);
});
