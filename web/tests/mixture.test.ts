// Mezcla de K ritmos (issue #27 Paso 2): ajuste EM, selección de K y
// predicción como mezcla. Corre con: npx tsx --test tests/mixture.test.ts
import { describe, it } from "node:test";
import assert from "assert/strict";
import {
  MIXTURE_MAX_K,
  MIXTURE_VERSION,
  fitMixture,
  mixtureResponsibilities,
  predictFromMixture,
  predictStore,
  selectMixtureK,
  type CustomerSessions,
  type MixtureEvidence,
  type MixtureFit,
  type StoreModelInput,
} from "@/lib/retention-model";

const DAY = 86_400_000;
const ASOF = Date.UTC(2026, 9, 17);

// PRNG determinista (mulberry32): sintéticos reproducibles, sin flakiness.
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

function lognormalGaps(rand: () => number, mu: number, sigma: number, n: number): number[] {
  const out: number[] = [];
  let spare: number | null = null;
  const gauss = (): number => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    do {
      u = rand();
      v = rand();
    } while (u <= 1e-12);
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  for (let i = 0; i < n; i += 1) out.push(Math.max(0.5, Math.exp(mu + sigma * gauss())));
  return out;
}

function baseInput(customers: CustomerSessions[]): StoreModelInput {
  return {
    asOf: ASOF,
    cycleDays: 30,
    horizonDays: 30,
    sigma0: 0.5,
    shopCurrency: "PEN",
    customers,
    suppressed: new Map(),
    isB2B: false,
  };
}

/** Tienda bimodal: nFast renovadores rápidos + nSlow lentos + nF1 F=1. */
function bimodalStore(nFast: number, nSlow: number, nF1: number, seed = 27): CustomerSessions[] {
  const rand = rng(seed);
  const out: CustomerSessions[] = [];
  const mkGaps = (rhythmMu: number, t: number, id: string): CustomerSessions => {
    const gaps = lognormalGaps(rand, rhythmMu, 0.4, 3);
    const last = ASOF - t * DAY;
    const ats = [last];
    for (let i = gaps.length - 1; i >= 0; i -= 1) ats.unshift(ats[0] - gaps[i] * DAY);
    return {
      customerId: id,
      sessions: ats.map((at) => ({ at, ticketMinor: 1000, currency: "PEN" })),
    };
  };
  for (let i = 0; i < nFast; i += 1) out.push(mkGaps(Math.log(7), 3 + (i % 20), `fast-${i}`));
  for (let i = 0; i < nSlow; i += 1) out.push(mkGaps(Math.log(60), 8 + (i % 40), `slow-${i}`));
  for (let i = 0; i < nF1; i += 1) {
    out.push({
      customerId: `f1-${i}`,
      sessions: [{ at: ASOF - (5 + i * 3) * DAY, ticketMinor: 1000, currency: "PEN" }],
    });
  }
  return out;
}

describe("fitMixture + selectMixtureK (issue #27 Paso 2)", () => {
  it("recupera 2 ritmos sintéticos y BIC elige K=2", () => {
    const rand = rng(1234);
    const gaps = [
      ...lognormalGaps(rand, Math.log(7), 0.4, 60),
      ...lognormalGaps(rand, Math.log(60), 0.4, 60),
    ];
    const cens = [5, 10, 20, 40, 80, 120];
    const cands: Array<MixtureFit | null> = [1, 2, 3].map((k) =>
      fitMixture(gaps, cens, k, { priorMu: Math.log(30), sigma0: 0.7 }),
    );
    const best = selectMixtureK(cands);
    assert.ok(best !== null && best.k === 2);
    const medians = best.components.map((c) => Math.exp(c.mu));
    assert.ok(Math.abs(medians[0] - 7) / 7 < 0.35, `mu0 -> ${medians[0]}`);
    assert.ok(Math.abs(medians[1] - 60) / 60 < 0.35, `mu1 -> ${medians[1]}`);
    // Pesos ~50/50 y componentes ordenados por μ.
    assert.ok(Math.abs(best.components[0].weight - 0.5) < 0.2);
    assert.ok(best.components[0].mu < best.components[1].mu);
  });

  it("datos homogéneos ⇒ K=1", () => {
    const rand = rng(99);
    const gaps = lognormalGaps(rand, Math.log(30), 0.5, 80);
    const cens = [10, 20, 30];
    const best = selectMixtureK(
      [1, 2, 3].map((k) => fitMixture(gaps, cens, k, { priorMu: Math.log(30), sigma0: 0.7 })),
    );
    assert.ok(best !== null && best.k === 1);
  });

  it("base chica ⇒ K>1 inválido (null si solo hay candidatos K>1)", () => {
    const gaps = [28, 32, 30, 29];
    const cens = [10, 15];
    const best = selectMixtureK([fitMixture(gaps, cens, 2)]);
    assert.equal(best, null);
  });

  it("rechaza k fuera de rango y sin datos", () => {
    assert.equal(fitMixture([10, 20], [], 0), null);
    assert.equal(fitMixture([10, 20], [], 5), null);
    assert.equal(fitMixture([], [], 2), null);
  });

  it("solo censurados (sin gaps): ajusta sobre el prior, K=1 válido", () => {
    const fit = fitMixture([], [10, 20, 30, 45], 1, { priorMu: Math.log(30), sigma0: 0.7 });
    assert.ok(fit !== null && fit.k === 1);
    assert.equal(fit.n, 4);
    assert.ok(Math.abs(fit.components[0].mu - Math.log(30)) < 1e-9);
    const best = selectMixtureK([fitMixture([], [10, 20, 30, 45], 2), fit]);
    assert.ok(best !== null && best.k === 1);
  });

  it("selectMixtureK all-null ⇒ null (el caller usa legacy)", () => {
    assert.equal(selectMixtureK([null, null]), null);
    assert.equal(selectMixtureK([]), null);
  });

  it("predictStore solo-F=1 con mixtureMaxK=4: fallback seguro, igual a legacy", () => {
    const customers: CustomerSessions[] = [5, 12, 30, 60, 200].map((t, i) => ({
      customerId: `solo-f1-${i}`,
      sessions: [{ at: ASOF - t * DAY, ticketMinor: 1000, currency: "PEN" as const }],
    }));
    const legacy = predictStore(baseInput(customers));
    const ev: MixtureEvidence = {};
    const got = predictStore({ ...baseInput(customers), mixtureMaxK: 4, mixtureEvidence: ev });
    assert.deepEqual(
      got.map((p) => [p.customerId, p.pRecompraH, p.decision, p.model]),
      legacy.map((p) => [p.customerId, p.pRecompraH, p.decision, p.model]),
    );
    assert.ok(got.every((p) => p.model === "segunda_compra"));
  });
});

describe("predictStore con mezcla (issue #27 Paso 2)", () => {
  it("default (null/1) es idéntico a legacy", () => {
    const customers = bimodalStore(6, 6, 4, 7);
    const legacy = predictStore(baseInput(customers));
    for (const flag of [null, undefined, 1]) {
      const input = baseInput(customers);
      if (flag !== undefined) input.mixtureMaxK = flag;
      const ev: MixtureEvidence = {};
      input.mixtureEvidence = ev;
      const got = predictStore(input);
      assert.deepEqual(
        got.map((p) => [p.customerId, p.pRecompraH, p.pLow, p.pHigh, p.decision, p.model]),
        legacy.map((p) => [p.customerId, p.pRecompraH, p.pLow, p.pHigh, p.decision, p.model]),
      );
      assert.equal(ev.store, null);
      assert.equal(ev.cohort, null);
    }
  });

  it("homogéneo con mixtureMaxK=4 ⇒ K=1 y camino legacy exacto", () => {
    const rand = rng(55);
    const customers: CustomerSessions[] = [];
    for (let i = 0; i < 30; i += 1) {
      const gaps = lognormalGaps(rand, Math.log(30), 0.5, 2);
      const last = ASOF - (5 + (i % 25)) * DAY;
      const ats = [last];
      for (let g = gaps.length - 1; g >= 0; g -= 1) ats.unshift(ats[0] - gaps[g] * DAY);
      customers.push({
        customerId: `h-${i}`,
        sessions: ats.map((at) => ({ at, ticketMinor: 1000, currency: "PEN" })),
      });
    }
    const legacy = predictStore(baseInput(customers));
    const ev: MixtureEvidence = {};
    const got = predictStore({ ...baseInput(customers), mixtureMaxK: 4, mixtureEvidence: ev });
    assert.deepEqual(
      got.map((p) => [p.customerId, p.pRecompraH, p.decision]),
      legacy.map((p) => [p.customerId, p.pRecompraH, p.decision]),
    );
    assert.ok(ev.store !== null && ev.store !== undefined && ev.store.k === 1);
  });

  it("bimodal con mixtureMaxK=4 activa K=2 y separa rápido/lento", () => {
    const customers = bimodalStore(40, 40, 20, 27);
    const ev: MixtureEvidence = {};
    const got = predictStore({ ...baseInput(customers), mixtureMaxK: 4, mixtureEvidence: ev });
    assert.ok(ev.store !== null && ev.store !== undefined);
    assert.equal(ev.store.k, 2);
    assert.ok(ev.respById !== undefined && ev.respById.size > 0);
    const byId = new Map(got.map((p) => [p.customerId, p]));
    // Pertenencia blanda: el rápido carga en el componente 0, el lento en el 1.
    const rFast = ev.respById.get("fast-0") ?? [];
    const rSlow = ev.respById.get("slow-0") ?? [];
    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum(rFast) - 1) < 1e-9);
    assert.ok(Math.abs(sum(rSlow) - 1) < 1e-9);
    assert.ok(rFast[0] > 0.7, `rFast=${rFast}`);
    assert.ok(rSlow[1] > 0.7, `rSlow=${rSlow}`);
    for (const p of got) {
      assert.ok(p.pRecompraH >= 0 && p.pRecompraH <= 1);
      // Intervalo paramétrico NO forzado a contener la media (misma doctrina
      // que la grilla legacy, issue #10 P2): con resp concentrada ambos
      // percentiles colapsan a la celda dominante. Solo orden y rango.
      assert.ok(p.pLow >= 0 && p.pLow <= p.pHigh && p.pHigh <= 1);
      assert.equal(p.decisionVersion, "v4:nodormido-exception");
      assert.ok(p.model === "renovacion" || p.model === "segunda_compra");
      if (p.p25Days !== null) assert.ok(p.p25Days >= 0);
      void byId;
    }
  });

  it("mixtureMaxK se acota a K≤4", () => {
    const customers = bimodalStore(40, 40, 20, 27);
    const ev: MixtureEvidence = {};
    predictStore({ ...baseInput(customers), mixtureMaxK: 99, mixtureEvidence: ev });
    assert.ok(ev.store !== null && ev.store !== undefined);
    assert.ok(ev.store.k <= MIXTURE_MAX_K);
  });
});

describe("predictFromMixture invariantes", () => {
  it("cuantiles condicionales no colapsan a t (regresión P0: < target, no < q)", () => {
    // Mezcla donde CDF(t) es grande (pertenencia dividida + t vencido):
    // el cuantil condicional debe resolver F(t)+q·S(t), estrictamente > t.
    // Con el bug (< q en vez de < target) la bisección colapsa a hi→t.
    const fit = {
      k: 2,
      components: [
        { weight: 0.5, mu: Math.log(10), sigma: 0.4 },
        { weight: 0.5, mu: Math.log(30), sigma: 0.4 },
      ],
    };
    const resp = [0.5, 0.5];
    const pr = predictFromMixture(fit, resp, 30, 60, 0);
    assert.ok(pr.p25 !== null && pr.p25 > 30 + 1, `p25=${pr.p25}`);
    assert.ok(pr.expDays !== null && pr.expDays > 30 + 1, `exp=${pr.expDays}`);
    assert.ok(pr.p75 !== null && pr.p75 >= (pr.expDays ?? 0), `p75=${pr.p75}`);
    // Coherencia ordinal p25 <= exp <= p75.
    assert.ok((pr.p25 ?? 0) <= (pr.expDays ?? 0) && (pr.expDays ?? 0) <= (pr.p75 ?? 0));
  });

  it("resp nula-sin-datos ⇒ prior; p en [0,1]; pLow<=mean<=pHigh", () => {
    const fit = fitMixture([6, 7, 8, 55, 60, 65], [10, 20], 2) ?? assert.fail("fit null");
    const prior = mixtureResponsibilities([], 0, fit);
    assert.deepEqual(
      prior.map((r) => Math.round(r * 1000) / 1000),
      fit.components.map((c) => Math.round(c.weight * 1000) / 1000),
    );
    const resp = mixtureResponsibilities([6.5, 7.2], 5, fit);
    assert.ok(Math.abs(resp.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    const pr = predictFromMixture(fit, resp, 5, 30, 0.1);
    assert.ok(pr.pMean >= 0 && pr.pMean <= 1);
    assert.ok(pr.pLow <= pr.pMean && pr.pMean <= pr.pHigh + 1e-12);
    assert.equal(MIXTURE_VERSION, "mix1:lognormal-em");
  });
});
