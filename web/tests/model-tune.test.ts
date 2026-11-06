// Tune mensual con backtest (issue #27 Paso 4): dataset, métricas, decisión.
// Puro (sin I/O/DB): el tuneModelParams de producción solo orquesta estas
// piezas + el escritor validado. Corre con: npx tsx --test tests/model-tune.test.ts
import { describe, it } from "node:test";
import assert from "assert/strict";
import {
  buildTuneSessions,
  decideTune,
  enumerateTuneWindows,
  evaluateTuneCurrent,
  evaluateTuneWindow,
  evaluateTuneWFO,
  labelTuneReturns,
  pairedBrierSE,
  partitionTuneDataset,
  scoreTuneSamples,
  tuneCutoff,
  tuneValidationHorizon,
  MODEL_TUNE_BRIER_MARGIN,
  type TuneCurrent,
  type TuneEntry,
  type TuneOrder,
  type TuneScored,
  type TuneScores,
} from "@/lib/model-tune";
import type { CustomerSessions } from "@/lib/retention-model";

const DAY = 86_400_000;
const H = 30;
const NOW = Date.UTC(2026, 9, 17);
const C = tuneCutoff(NOW, H);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const scores = (brier: number, logLoss?: number): TuneScores => ({
  n: 100,
  events: 30,
  brier,
  logLoss: logLoss ?? brier,
  liftTop: 2,
  baseRate: 0.3,
  deciles: [],
});

const entry = (window: number | null, k: number, brier: number, logLoss?: number): TuneEntry => ({
  window,
  mixture:
    k <= 1
      ? null
      : {
          k,
          components: Array.from({ length: k }, (_, i) => ({
            weight: 1 / k,
            mu: Math.log(7) + i,
            sigma: 0.4,
          })),
        },
  scores: scores(brier, logLoss ?? brier),
});

const cur = (
  window: number | null,
  k: number,
  brier: number,
  hasRow = true,
  logLoss?: number,
): TuneCurrent & { scores: TuneScores } => ({
  window,
  mixture:
    k <= 1
      ? null
      : {
          k,
          components: Array.from({ length: k }, (_, i) => ({
            weight: 1 / k,
            mu: Math.log(7) + i,
            sigma: 0.4,
          })),
        },
  hasRow,
  scores: scores(brier, logLoss ?? brier),
});

describe("tuneCutoff + buildTuneSessions + labelTuneReturns", () => {
  it("corte = now - H; sesiones solo ≤ corte; etiquetas en (C,C+H]", () => {
    assert.equal(tuneCutoff(NOW, 30), NOW - 30 * DAY);
    const orders: TuneOrder[] = [
      { customerId: "a", at: C - 40 * DAY, ticketMinor: 100, currency: "PEN" },
      { customerId: "a", at: C - 10 * DAY, ticketMinor: 100, currency: "PEN" },
      { customerId: "a", at: C + 5 * DAY, ticketMinor: 100, currency: "PEN" },
      { customerId: "b", at: C - 50 * DAY, ticketMinor: 100, currency: "PEN" },
      { customerId: "c", at: C + 1 * DAY, ticketMinor: 100, currency: "PEN" },
    ];
    const sessions = buildTuneSessions(orders, C);
    // c solo tiene órdenes post-corte ⇒ fuera; a y b dentro.
    assert.deepEqual(
      sessions.map((s) => s.customerId).sort(),
      ["a", "b"],
    );
    const labeled = labelTuneReturns(
      sessions.map((s) => ({ customerId: s.customerId, p: 0.5 })),
      orders,
      C,
      H,
    );
    assert.equal(labeled.find((l) => l.customerId === "a")?.returned, true);
    assert.equal(labeled.find((l) => l.customerId === "b")?.returned, false);
    // Bordes: at==C no etiqueta; at==C+H sí.
    const edge = labelTuneReturns(
      [{ customerId: "x", p: 0.5 }],
      [
        { customerId: "x", at: C, ticketMinor: 1, currency: null },
        { customerId: "y", at: C + H * DAY, ticketMinor: 1, currency: null },
      ],
      C,
      H,
    );
    assert.equal(edge[0].returned, false);
  });
});

describe("scoreTuneSamples", () => {
  it("predictor perfecto ⇒ brier/logloss ≈ 0; vacío ⇒ ceros", () => {
    const perfect = scoreTuneSamples([
      { customerId: "a", p: 1, returned: true },
      { customerId: "b", p: 0, returned: false },
    ]);
    assert.equal(perfect.brier, 0);
    assert.ok(perfect.logLoss < 1e-4);
    assert.equal(perfect.events, 1);
    const empty = scoreTuneSamples([]);
    assert.equal(empty.n, 0);
    assert.equal(empty.liftTop, null);
  });

  it("deciles suman n y liftTop>1 si p ordena", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({
      customerId: `c${i}`,
      p: (i + 1) / 20,
      returned: i >= 14,
    }));
    const s = scoreTuneSamples(samples);
    assert.equal(
      s.deciles.reduce((a, d) => a + d.n, 0),
      20,
    );
    assert.ok((s.liftTop ?? 0) > 1);
  });
});

describe("enumerateTuneWindows", () => {
  it("vigente + candidatas + vuelta a legacy; sin duplicados", () => {
    assert.deepEqual(enumerateTuneWindows(14), [14, null, 7, 30]);
    assert.deepEqual(enumerateTuneWindows(null), [7, 14, 30]);
    assert.deepEqual(enumerateTuneWindows(7), [7, null, 14, 30]);
  });
});

describe("decideTune", () => {
  const STATS = { n: 100, events: 30 };

  it("datos insuficientes ⇒ keep", () => {
    const d = decideTune(cur(null, 1, 0.2), [entry(7, 2, 0.1)], { n: 10, events: 2 });
    assert.equal(d.action, "keep");
    assert.equal(d.candidate, null);
  });

  it("mismo K con victoria por margen ⇒ apply", () => {
    const d = decideTune(cur(14, 2, 0.2), [entry(14, 2, 0.2 - MODEL_TUNE_BRIER_MARGIN - 0.001)], STATS);
    assert.equal(d.action, "apply");
    assert.equal(d.candidate?.window, 14);
    assert.equal(d.candidate?.mixture?.k, 2);
  });

  it("sin margen ⇒ keep", () => {
    const d = decideTune(cur(14, 2, 0.2), [entry(14, 2, 0.2 - MODEL_TUNE_BRIER_MARGIN + 0.001)], STATS);
    assert.equal(d.action, "keep");
  });

  it("log-loss peor más allá de tolerancia ⇒ keep aunque brier gane", () => {
    const d = decideTune(cur(14, 2, 0.2, true, 0.5), [entry(14, 2, 0.1, 0.9)], STATS);
    assert.equal(d.action, "keep");
  });

  it("ventana a <2d de la vigente ⇒ se queda en la vigente", () => {
    const d = decideTune(cur(14, 1, 0.2), [entry(15, 1, 0.1), entry(14, 1, 0.19)], STATS);
    assert.equal(d.action, "apply");
    assert.equal(d.candidate?.window, 14);
  });

  it("trust region: salto de μ fuera de rango ⇒ keep", () => {
    const far: TuneEntry = {
      window: 14,
      mixture: {
        k: 2,
        components: [
          { weight: 0.5, mu: Math.log(7) + 2, sigma: 0.4 },
          { weight: 0.5, mu: Math.log(60), sigma: 0.4 },
        ],
      },
      scores: scores(0.1),
    };
    const d = decideTune(cur(14, 2, 0.2), [far], STATS);
    assert.equal(d.action, "keep");
  });

  it("estructural 1→3 con fila ⇒ propose (no auto-aplica)", () => {
    const d = decideTune(cur(null, 1, 0.25), [entry(14, 3, 0.1)], STATS);
    assert.equal(d.action, "propose");
    assert.equal(d.candidate, null);
    assert.match(d.reason, /requiere revisión/);
  });

  it("emergencia en frío K≤2 con doble margen ⇒ apply", () => {
    const d = decideTune(cur(null, 1, 0.25, false), [entry(14, 2, 0.25 - 2 * MODEL_TUNE_BRIER_MARGIN - 0.001)], STATS);
    assert.equal(d.action, "apply");
    assert.equal(d.candidate?.mixture?.k, 2);
  });

  it("emergencia en frío K=3 ⇒ propose aunque gane", () => {
    const d = decideTune(cur(null, 1, 0.25, false), [entry(14, 3, 0.05)], STATS);
    assert.equal(d.action, "propose");
  });

  it("sin candidatas ⇒ keep", () => {
    const d = decideTune(cur(null, 1, 0.2), [], STATS);
    assert.equal(d.action, "keep");
  });
});

describe("evaluateTuneWindow end-to-end (sintético bimodal)", () => {
  // Población donde la mezcla debe ganar: ritmos rápidos + lentos con
  // historial largo (legacy los resuelve por shrinkage) + lentos de
  // historial CORTO y F1 (donde el prior —mezcla vs mu único— decide).
  // Timeline generativo consistente: compras secuenciales hasta C+H; la
  // etiqueta es compra real en (C,C+H]; F1 con siguiente gap condicionado
  // (g*>t) o churn si t supera 3× la mediana del ritmo.
  const buildBimodal = (): { sessions: CustomerSessions[]; orders: TuneOrder[] } => {
    const rand = rng(27);
    const gauss = (): number => {
      let u = 0;
      let v = 0;
      do {
        u = rand();
        v = rand();
      } while (u <= 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const logn = (mu: number, s: number): number => Math.max(0.5, Math.exp(mu + s * gauss()));
    const orders: TuneOrder[] = [];
    const at = (id: string, tRelDays: number): void => {
      orders.push({ customerId: id, at: C + tRelDays * DAY, ticketMinor: 1000, currency: "PEN" });
    };
    const timeline = (id: string, mu: number, fromDays: number): void => {
      let t = fromDays;
      for (;;) {
        t += logn(mu, 0.4);
        if (t > H) break;
        at(id, t);
      }
    };
    for (let i = 0; i < 10; i += 1) timeline(`fast-${i}`, Math.log(7), -400);
    for (let i = 0; i < 30; i += 1) timeline(`slow-${i}`, Math.log(60), -400);
    for (let i = 0; i < 40; i += 1) {
      const t = 5 + Math.floor(rand() * 76);
      const g = logn(Math.log(60), 0.4);
      at(`sh-${i}`, -(t + g));
      at(`sh-${i}`, -t);
      let g2 = -1;
      for (let k = 0; k < 100 && g2 <= t; k += 1) g2 = logn(Math.log(60), 0.4);
      if (g2 > t && g2 <= t + H) at(`sh-${i}`, -t + g2);
    }
    for (let i = 0; i < 20; i += 1) {
      const mu = i % 2 ? Math.log(7) : Math.log(60);
      const t = 5 + Math.floor(rand() * 115);
      at(`f1-${i}`, -t);
      if (t > 3 * Math.exp(mu)) continue;
      let g = -1;
      for (let k = 0; k < 100 && g <= t; k += 1) g = logn(mu, 0.4);
      if (g > t && g <= t + H) at(`f1-${i}`, -t + g);
    }
    return { sessions: buildTuneSessions(orders, C), orders };
  };

  it("cada ventana candidata ajusta su propia mezcla (P1: no se reutiliza la de legacy)", () => {
    // Regresión: el ajuste solía omitir episodeGapDays y todas las ventanas
    // compartían la mezcla legacy. Con fusión agresiva (w=30) la distribución
    // de gaps cambia ⇒ el fit debe diferir del de w=null.
    const { sessions } = buildBimodal();
    const base = { asOf: C, cycleDays: 30, horizonDays: H, sigma0: 0.5 };
    const legacy = evaluateTuneWindow(sessions, base, null);
    const fused = evaluateTuneWindow(sessions, base, 30);
    assert.ok(legacy.mixture !== null && legacy.mixture.k === 2);
    assert.notDeepEqual(
      fused.mixture?.components.map((c) => c.mu),
      legacy.mixture.components.map((c) => c.mu),
    );
  });

  it("la mezcla K=2 gana a legacy en Brier sobre la mezcla sintética", () => {
    const { sessions, orders } = buildBimodal();
    const base = { asOf: C, cycleDays: 30, horizonDays: H, sigma0: 0.5 };
    const legacyPreds = evaluateTuneCurrent(sessions, base, { window: null, mixture: null });
    const legacyScores = scoreTuneSamples(labelTuneReturns(legacyPreds, orders, C, H));
    assert.ok(legacyScores.n >= 60);
    assert.ok(legacyScores.events >= 10);
    let best: { window: number | null; brier: number; k: number } | null = null;
    for (const w of enumerateTuneWindows(null)) {
      const { mixture, preds } = evaluateTuneWindow(sessions, base, w);
      const s = scoreTuneSamples(labelTuneReturns(preds, orders, C, H));
      const k = mixture?.k ?? 1;
      if (best === null || s.brier < best.brier) best = { window: w, brier: s.brier, k };
    }
    assert.ok(best !== null && best.k === 2);
    assert.ok(best.brier < legacyScores.brier - MODEL_TUNE_BRIER_MARGIN);
  });
});

describe("release gate multi-tenant (Paso 5.3: la mezcla no pierde)", () => {
  // Backtest reproducible sobre tenants sintéticos de distinto carácter:
  // heterogéneos ⇒ la mezcla se activa y gana; homogéneos ⇒ K=1 con camino
  // legacy exacto (empate) y el tune conserva.
  const buildGateTenant = (seed: number, kind: "mix" | "homog"): { sessions: CustomerSessions[]; orders: TuneOrder[] } => {
    const rand = rng(seed * 1000 + 11);
    const gauss = (): number => {
      let u = 0;
      let v = 0;
      do {
        u = rand();
        v = rand();
      } while (u <= 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const logn = (mu: number, s: number): number => Math.max(0.5, Math.exp(mu + s * gauss()));
    const orders: TuneOrder[] = [];
    const at = (id: string, tRelDays: number): void => {
      orders.push({ customerId: id, at: C + tRelDays * DAY, ticketMinor: 1000, currency: "PEN" });
    };
    const timeline = (id: string, mu: number, fromDays: number): void => {
      let t = fromDays;
      for (;;) {
        t += logn(mu, 0.4);
        if (t > H) break;
        at(id, t);
      }
    };
    if (kind === "mix") {
      for (let i = 0; i < 10; i += 1) timeline(`fast-${i}`, Math.log(7), -400);
      for (let i = 0; i < 30; i += 1) timeline(`slow-${i}`, Math.log(60), -400);
      for (let i = 0; i < 40; i += 1) {
        const t = 5 + Math.floor(rand() * 76);
        const g = logn(Math.log(60), 0.4);
        at(`sh-${i}`, -(t + g));
        at(`sh-${i}`, -t);
        let g2 = -1;
        for (let k = 0; k < 100 && g2 <= t; k += 1) g2 = logn(Math.log(60), 0.4);
        if (g2 > t && g2 <= t + H) at(`sh-${i}`, -t + g2);
      }
    } else {
      for (let i = 0; i < 100; i += 1) timeline(`h-${i}`, Math.log(30), -400);
    }
    for (let i = 0; i < 20; i += 1) {
      const mu = kind === "homog" ? Math.log(30) : i % 2 ? Math.log(7) : Math.log(60);
      const t = 5 + Math.floor(rand() * 115);
      at(`f1-${i}`, -t);
      if (t > 3 * Math.exp(mu)) continue;
      let g = -1;
      for (let k = 0; k < 100 && g <= t; k += 1) g = logn(mu, 0.4);
      if (g > t && g <= t + H) at(`f1-${i}`, -t + g);
    }
    return { sessions: buildTuneSessions(orders, C), orders };
  };

  const runGate = (seed: number, kind: "mix" | "homog") => {
    const { sessions, orders } = buildGateTenant(seed, kind);
    const base = { asOf: C, cycleDays: 30, horizonDays: H, sigma0: 0.5 };
    const legacyScores = scoreTuneSamples(
      labelTuneReturns(evaluateTuneCurrent(sessions, base, { window: null, mixture: null }), orders, C, H),
    );
    const entries: TuneEntry[] = enumerateTuneWindows(null).map((w) => {
      const { mixture, preds } = evaluateTuneWindow(sessions, base, w);
      return { window: w, mixture, scores: scoreTuneSamples(labelTuneReturns(preds, orders, C, H)) };
    });
    const decision = decideTune(
      { window: null, mixture: null, hasRow: false, scores: legacyScores },
      entries,
      { n: legacyScores.n, events: legacyScores.events },
      { horizonDays: H },
    );
    return { legacyScores, entries, decision };
  };

  it("heterogéneo (seed 99) ⇒ apply con K=2", () => {
    const { legacyScores, decision } = runGate(99, "mix");
    assert.ok(legacyScores.n >= 60 && legacyScores.events >= 10);
    assert.equal(decision.action, "apply");
    assert.equal(decision.candidate?.mixture?.k, 2);
    assert.match(decision.reason, /últimos 30 días/);
  });

  it("homogéneo ⇒ K=1 en todas las ventanas y el tune conserva", () => {
    const { entries, decision } = runGate(27, "homog");
    assert.ok(entries.every((e) => (e.mixture?.k ?? 1) === 1));
    assert.equal(decision.action, "keep");
    assert.equal(decision.candidate, null);
  });
});

describe("partitionTuneDataset (single-país, una partición)", () => {
  const tOrder = (customerId: string, tRel: number): TuneOrder => ({
    customerId,
    at: C + tRel * DAY,
    ticketMinor: 1000,
    currency: "PEN",
  });

  it("una sola partición tienda con todos los clientes ≤ corte", () => {
    const customers = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ];
    const orders = [
      tOrder("a", -10), tOrder("a", -20), tOrder("a", -30),
      tOrder("b", -10),
      tOrder("c", -10),
    ];
    const parts = partitionTuneDataset(customers, orders, C);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].marketId, null);
    assert.equal(parts[0].label, "tienda");
    assert.ok(parts[0].customers.some((c) => c.id === "a"));
    assert.ok(parts[0].customers.some((c) => c.id === "b"));
    assert.ok(parts[0].customers.some((c) => c.id === "c"));
  });

  it("sin compras ≤ corte fuera", () => {
    const customers = [
      { id: "a" },
      { id: "future" },
    ];
    const orders = [
      tOrder("a", -10),
      tOrder("a", -20),
      { customerId: "future", at: C + 5 * DAY, ticketMinor: 1000, currency: "PEN" },
    ];
    const parts = partitionTuneDataset(customers, orders, C);
    assert.equal(parts.length, 1);
    assert.ok(parts[0].customers.some((c) => c.id === "a"));
    assert.ok(!parts[0].customers.some((c) => c.id === "future"));
  });

  it("tune single-país: mezcla aplica donde hay señal", () => {
    // m1: mezcla heterogénea (gana); m2: 5 clientes homogéneos (mínimos).
    const rand = rng(4242);
    const gauss = (): number => {
      let u = 0;
      let v = 0;
      do {
        u = rand();
        v = rand();
      } while (u <= 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const logn = (mu: number, s: number): number => Math.max(0.5, Math.exp(mu + s * gauss()));
    const orders: TuneOrder[] = [];
    const customers: { id: string }[] = [];
    const at = (id: string, t: number): void => {
      orders.push({ customerId: id, at: C + t * DAY, ticketMinor: 1000, currency: "PEN" });
    };
    for (let i = 0; i < 10; i += 1) {
      customers.push({ id: `f-${i}` });
      let t = -400;
      for (;;) {
        t += logn(Math.log(7), 0.4);
        if (t > H) break;
        at(`f-${i}`, t);
      }
    }
    for (let i = 0; i < 30; i += 1) {
      customers.push({ id: `s-${i}` });
      let t = -400;
      for (;;) {
        t += logn(Math.log(60), 0.4);
        if (t > H) break;
        at(`s-${i}`, t);
      }
    }
    for (let i = 0; i < 40; i += 1) {
      customers.push({ id: `sh-${i}` });
      const t = 5 + Math.floor(rand() * 76);
      const g = logn(Math.log(60), 0.4);
      at(`sh-${i}`, -(t + g));
      at(`sh-${i}`, -t);
      let g2 = -1;
      for (let k = 0; k < 100 && g2 <= t; k += 1) g2 = logn(Math.log(60), 0.4);
      if (g2 > t && g2 <= t + H) at(`sh-${i}`, -t + g2);
    }
    const parts = partitionTuneDataset(customers, orders, C);
    assert.equal(parts.length, 1);
    const base = { asOf: C, cycleDays: 30, horizonDays: H, sigma0: 0.5 };
    const actions = new Map<string | null, string>();
    for (const part of parts) {
      const sessions = buildTuneSessions(part.orders, C);
      const legacyScores = scoreTuneSamples(
        labelTuneReturns(evaluateTuneCurrent(sessions, base, { window: null, mixture: null }), part.orders, C, H),
      );
      const entries: TuneEntry[] = enumerateTuneWindows(null).map((w) => {
        const { mixture, preds } = evaluateTuneWindow(sessions, base, w);
        return { window: w, mixture, scores: scoreTuneSamples(labelTuneReturns(preds, part.orders, C, H)) };
      });
      const d = decideTune(
        { window: null, mixture: null, hasRow: false, scores: legacyScores },
        entries,
        { n: legacyScores.n, events: legacyScores.events },
        { horizonDays: H },
      );
      actions.set(part.marketId, d.action);
    }
    // Con señal heterogénea suficiente el tune aplica o propone estructura.
    assert.ok(["apply", "propose"].includes(actions.get(null) ?? ""));
  });
});

describe("tuneValidationHorizon (regla del método, tempo por tenant)", () => {
  it("3×H con tope 180", () => {
    assert.equal(tuneValidationHorizon(30), 90);
    assert.equal(tuneValidationHorizon(45), 135);
    assert.equal(tuneValidationHorizon(60), 180);
    assert.equal(tuneValidationHorizon(90), 180);
    assert.equal(tuneValidationHorizon(0), 90);
    assert.equal(tuneValidationHorizon(Number.NaN), 90);
  });
});

describe("pairedBrierSE (que no decida un solo cliente)", () => {
  const mk = (id: string, p: number, returned: boolean, origin?: number): TuneScored => ({
    customerId: id, p, returned, ...(origin === undefined ? {} : { origin }),
  });

  it("null sin muestras o con <2 pares; 0 si idénticos", () => {
    assert.equal(pairedBrierSE(undefined, [mk("a", 0.5, true)]), null);
    assert.equal(pairedBrierSE([mk("a", 0.5, true)], [mk("a", 0.4, true)]), null);
    assert.equal(pairedBrierSE([mk("a", 0.5, true)], [mk("a", 0.5, true)]), null);
    const same = [mk("a", 0.5, true), mk("b", 0.2, false)];
    assert.equal(pairedBrierSE(same, same.map((s) => ({ ...s }))), 0);
  });

  it("un solo cliente distinto ⇒ SE grande", () => {
    const cur = Array.from({ length: 100 }, (_, i) => mk(`c${i}`, 0.1, false));
    const cand = cur.map((s, i) => (i === 0 ? { ...s, p: 0.9 } : { ...s }));
    const se = pairedBrierSE(cur, cand);
    assert.ok(se !== null && se > 0.005, `se=${se}`);
  });

  it("victoria pareja y amplia ⇒ SE chico frente al efecto", () => {
    const cur = Array.from({ length: 100 }, (_, i) => mk(`c${i}`, 0.5, i % 2 === 0));
    const cand = Array.from({ length: 100 }, (_, i) => mk(`c${i}`, i % 2 === 0 ? 0.9 : 0.1, i % 2 === 0));
    const se = pairedBrierSE(cur, cand);
    // dBrier = mean((0.9-1)^2-(0.5-1)^2 / ...) = 0.24 por retornado y 0.24 por no: total 0.24.
    assert.ok(se !== null && se < 0.02, `se=${se}`);
  });

  it("parea por cliente+origen (mismo cliente en 2 orígenes)", () => {
    const cur = [mk("a", 0.5, true, 0), mk("a", 0.5, false, 1)];
    const cand = [mk("a", 0.9, true, 0), mk("a", 0.1, false, 1)];
    const se = pairedBrierSE(cur, cand);
    assert.ok(se !== null && Number.isFinite(se));
    // Sin origen se aparearían mal (2 pares → 1): con origen hay 2 pares.
    const curNo = [mk("a", 0.5, true), mk("a", 0.5, false)];
    assert.equal(pairedBrierSE(curNo, [mk("a", 0.9, true)]), null);
  });
});

describe("decideTune con margen por ruido", () => {
  const STATS = { n: 100, events: 30 };

  it("empate ruidoso que el margen fijo aprobaría ⇒ SE lo frena (keep)", () => {
    // 100 clientes p=0.5 (brier 0.25). Candidata mejora en 2 y nada en 98:
    // dBrier=0.0034 > fijo 0.003 (la vieja regla aplicaría), pero 2·SE≈0.0053.
    const cur = Array.from({ length: 100 }, (_, i) => ({
      customerId: `c${i}`, p: 0.5, returned: i % 2 === 0,
    }));
    const cand = cur.map((s, i) => {
      if (i === 0) return { ...s, p: 1.0 }; // returned: (0−0.25)
      if (i === 1) return { ...s, p: 0.4 }; // not: (0.16−0.25)
      return { ...s };
    });
    const e = entry(14, 1, scoreTuneSamples(cand).brier);
    e.samples = cand;
    const base = cur_(14, 1, scoreTuneSamples(cur).brier);
    const cc = { ...base, scores: scoreTuneSamples(cur), samples: cur };
    const d = decideTune(cc, [e], STATS);
    assert.equal(d.action, "keep");
  });

  it("victoria clara más allá del ruido ⇒ apply", () => {
    const cur = Array.from({ length: 100 }, (_, i) => ({
      customerId: `c${i}`, p: 0.5, returned: i % 2 === 0,
    }));
    const cand = Array.from({ length: 100 }, (_, i) => ({
      customerId: `c${i}`, p: i % 2 === 0 ? 0.9 : 0.1, returned: i % 2 === 0,
    }));
    const e = entry(14, 1, scoreTuneSamples(cand).brier);
    e.samples = cand;
    const base = cur_(14, 1, scoreTuneSamples(cur).brier);
    const cc = { ...base, scores: scoreTuneSamples(cur), samples: cur };
    const d = decideTune(cc, [e], STATS);
    assert.equal(d.action, "apply");
  });

  it("un solo cliente decide ⇒ SE lo frena (keep)", () => {
    const cur = Array.from({ length: 100 }, (_, i) => ({
      customerId: `c${i}`, p: 0.5, returned: i === 0,
    }));
    const cand = cur.map((s, i) => (i === 0 ? { ...s, p: 1.0 } : { ...s }));
    // dBrier=0.0025; SE≈0.0025 → 2·SE≈0.005 > d.
    const e = entry(14, 1, scoreTuneSamples(cand).brier);
    e.samples = cand;
    const base = cur_(14, 1, scoreTuneSamples(cur).brier);
    const cc = { ...base, scores: scoreTuneSamples(cur), samples: cur };
    const d = decideTune(cc, [e], STATS);
    assert.equal(d.action, "keep");
  });

  it("sin muestras ⇒ rige el margen fijo (compatibilidad)", () => {
    const e = entry(14, 1, 0.2 - MODEL_TUNE_BRIER_MARGIN - 0.001);
    assert.equal(e.samples, undefined);
    const d = decideTune(cur(14, 2, 0.2), [e], STATS);
    // K difiere sin muestras: pasa el margen fijo y propone (no auto-aplica).
    assert.equal(d.action, "propose");
  });

  function cur_(window: number | null, k: number, brier: number) {
    return cur(window, k, brier);
  }
});

describe("evaluateTuneWFO (walk-forward pooled)", () => {
  const wfoCustomers = (orders: TuneOrder[]): Array<{ id: string }> =>
    [...new Set(orders.map((o) => o.customerId))].map((id) => ({ id }));
  const wfoCurrent = () => ({ window: null as number | null, mixture: null, hasRow: false });

  it("pooled = concat de orígenes; mezcla = fit en C0; tabla por origen", () => {
    const rand = rng(4242);
    const gauss = (): number => {
      let u = 0;
      let v = 0;
      do {
        u = rand();
        v = rand();
      } while (u <= 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const logn = (mu: number, s: number): number => Math.max(0.5, Math.exp(mu + s * gauss()));
    const orders: TuneOrder[] = [];
    for (let i = 0; i < 15; i += 1) {
      const mu = i % 2 ? Math.log(60) : Math.log(7);
      let t = -300;
      for (;;) {
        t += logn(mu, 0.4);
        if (t > H) break;
        orders.push({ customerId: `c${i}`, at: C + t * DAY, ticketMinor: 1000, currency: "PEN" });
      }
    }
    const origins = [C, tuneCutoff(NOW, 2 * H)];
    const byMarket = evaluateTuneWFO(orders, wfoCustomers(orders), origins, { cycleDays: 30, sigma0: 0.5 }, wfoCurrent, H);
    // Sin markets ni países: una sola partición null.
    assert.equal(byMarket.size, 1);
    const wfo = byMarket.get(null);
    assert.ok(wfo !== undefined);
    assert.equal(wfo.perWindow.length, 3); // [7,14,30], sin vigente
    for (const pw of wfo.perWindow) {
      const sumN = pw.origins.reduce((a, o) => a + o.n, 0);
      assert.equal(pw.pooled.length, sumN);
      assert.equal(pw.origins.length, 2);
      assert.ok(pw.origins.every((o) => o.cutoff <= NOW));
    }
    assert.ok(wfo.currentPooled.length > 0);
  });

  it("decisión WFO pooled: heterogéneo aplica con K=2", () => {
    // 2 orígenes sobre la mezcla bimodal: el pooled sostiene la victoria.
    const rand = rng(777);
    const gauss = (): number => {
      let u = 0;
      let v = 0;
      do {
        u = rand();
        v = rand();
      } while (u <= 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const logn = (mu: number, s: number): number => Math.max(0.5, Math.exp(mu + s * gauss()));
    const orders: TuneOrder[] = [];
    const mkTimeline = (id: string, mu: number, from: number): void => {
      let t = from;
      for (;;) {
        t += logn(mu, 0.4);
        if (t > H) break;
        orders.push({ customerId: id, at: C + t * DAY, ticketMinor: 1000, currency: "PEN" });
      }
    };
    for (let i = 0; i < 10; i += 1) mkTimeline(`wf-fast-${i}`, Math.log(7), -400);
    for (let i = 0; i < 30; i += 1) mkTimeline(`wf-slow-${i}`, Math.log(60), -400);
    for (let i = 0; i < 40; i += 1) {
      const t = 5 + Math.floor(rand() * 76);
      const g = logn(Math.log(60), 0.4);
      orders.push({ customerId: `wf-sh-${i}`, at: C + (-(t + g)) * DAY, ticketMinor: 1000, currency: "PEN" });
      orders.push({ customerId: `wf-sh-${i}`, at: C - t * DAY, ticketMinor: 1000, currency: "PEN" });
      let g2 = -1;
      for (let k = 0; k < 100 && g2 <= t; k += 1) g2 = logn(Math.log(60), 0.4);
      if (g2 > t && g2 <= t + H) {
        orders.push({ customerId: `wf-sh-${i}`, at: C + (-t + g2) * DAY, ticketMinor: 1000, currency: "PEN" });
      }
    }
    const origins = [C, tuneCutoff(NOW, 2 * H)];
    const byMarket = evaluateTuneWFO(
      orders, wfoCustomers(orders), origins, { cycleDays: 30, sigma0: 0.5 },
      wfoCurrent, H,
    );
    const wfo = byMarket.get(null);
    assert.ok(wfo !== undefined);
    const currentScores = scoreTuneSamples(wfo.currentPooled);
    const entries: TuneEntry[] = wfo.perWindow.map((pw) => ({
      window: pw.window,
      mixture: pw.mixture,
      scores: scoreTuneSamples(pw.pooled),
      samples: pw.pooled,
    }));
    assert.ok(currentScores.n >= 60 && currentScores.events >= 10);
    const decision = decideTune(
      { window: null, mixture: null, hasRow: false, scores: currentScores, samples: wfo.currentPooled },
      entries,
      { n: currentScores.n, events: currentScores.events },
      { horizonDays: H },
    );
    assert.equal(decision.action, "apply");
    assert.equal(decision.candidate?.mixture?.k, 2);
  });
});
