// Parámetros por tenant (issue #27 Paso 3): validación pura, prioridad por
// partición y fits explícitos en predictStore. Sin I/O: la lectura a
// Postgres (resolveModelParams) es fail-open y la cubre el mismo patrón que
// resolveBandCuts. Corre con: npx tsx --test tests/model-params.test.ts
import { describe, it } from "node:test";
import assert from "assert/strict";
import {
  asValidMixtureFit,
  predictStore,
  type CustomerSessions,
  type MixtureEvidence,
  type StoreModelInput,
} from "@/lib/retention-model";
import {
  isSupportedModelParamsVersion,
  paramsForPartition,
  pickModelParams,
  validateModelParams,
} from "@/lib/model-params";

const DAY = 86_400_000;
const ASOF = Date.UTC(2026, 9, 17);
const V_MIX = "mix1:lognormal-em";
const V_EP = "ep1:gap-keys";

const GOOD = {
  episode_window_days: 14,
  mixture: {
    k: 2,
    components: [
      { weight: 0.5, mu: Math.log(60), sigma: 0.4 },
      { weight: 0.5, mu: Math.log(7), sigma: 0.4 },
    ],
  },
};

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

describe("validateModelParams (issue #27 Paso 3)", () => {
  it("payload bueno ⇒ parsea y ordena por μ", () => {
    const v = validateModelParams(GOOD, V_MIX);
    assert.ok(v !== null);
    assert.equal(v.episodeWindowDays, 14);
    assert.ok(v.mixture !== null && v.mixture.k === 2);
    assert.ok(v.mixture.components[0].mu < v.mixture.components[1].mu);
    assert.ok(Math.abs(Math.exp(v.mixture.components[0].mu) - 7) < 1e-9);
  });

  it("versión ausente o desconocida ⇒ null (P2: no aplicar en silencio)", () => {
    assert.equal(validateModelParams(GOOD), null);
    assert.equal(validateModelParams(GOOD, null), null);
    assert.equal(validateModelParams(GOOD, "mix2:futurista"), null);
    assert.equal(validateModelParams(GOOD, ""), null);
    // Versiones soportadas: mezcla y episodio.
    assert.ok(validateModelParams({ episode_window_days: 14 }, V_EP) !== null);
    assert.ok(isSupportedModelParamsVersion(V_MIX));
    assert.ok(isSupportedModelParamsVersion(V_EP));
    assert.ok(!isSupportedModelParamsVersion("mix2"));
  });

  it("ventana <=1/inválida ⇒ null (legacy), sin rechazar el payload", () => {
    for (const w of [1, 0, -3, Number.NaN, "14", undefined]) {
      const v = validateModelParams({ episode_window_days: w }, V_EP);
      assert.ok(v !== null && v.episodeWindowDays === null && v.mixture === null);
    }
    assert.equal(validateModelParams({}, V_EP)?.episodeWindowDays, null);
  });

  it("ventana >60 ⇒ rechaza el payload entero (colapsaría F)", () => {
    assert.equal(validateModelParams({ episode_window_days: 61 }, V_EP), null);
    assert.equal(validateModelParams({ episode_window_days: 1e12 }, V_EP), null);
    assert.equal(validateModelParams({ ...GOOD, episode_window_days: 90 }, V_MIX), null);
    // Frontera 60 válida.
    assert.equal(validateModelParams({ episode_window_days: 60 }, V_EP)?.episodeWindowDays, 60);
  });

  it("componentes fuera de rango operativo ⇒ null", () => {
    const badMu = {
      mixture: { k: 1, components: [{ weight: 1, mu: 1e100, sigma: 0.5 }] },
    };
    const badSigmaLo = {
      mixture: { k: 1, components: [{ weight: 1, mu: 3, sigma: 1e-9 }] },
    };
    const badSigmaHi = {
      mixture: { k: 1, components: [{ weight: 1, mu: 3, sigma: 5 }] },
    };
    assert.equal(validateModelParams(badMu, V_MIX), null);
    assert.equal(validateModelParams(badSigmaLo, V_MIX), null);
    assert.equal(validateModelParams(badSigmaHi, V_MIX), null);
    // Fronteras válidas: μ=0 (ln1), σ=0.25 y σ=1.4.
    assert.ok(
      validateModelParams(
        { mixture: { k: 1, components: [{ weight: 1, mu: 0, sigma: 0.25 }] } },
        V_MIX,
      ) !== null,
    );
  });

  it("rechaza formas inválidas", () => {
    assert.equal(validateModelParams(null, V_MIX), null);
    assert.equal(validateModelParams("x", V_MIX), null);
    assert.equal(validateModelParams([], V_MIX), null);
    // k fuera de rango / desalineado
    assert.equal(validateModelParams({ mixture: { k: 0, components: [] } }, V_MIX), null);
    assert.equal(validateModelParams({ mixture: { k: 5, components: [] } }, V_MIX), null);
    assert.equal(
      validateModelParams(
        { mixture: { k: 2, components: [GOOD.mixture.components[0]] } },
        V_MIX,
      ),
      null,
    );
    // pesos
    assert.equal(
      validateModelParams(
        {
          mixture: {
            k: 2,
            components: [
              { weight: 0.3, mu: 1, sigma: 0.5 },
              { weight: 0.3, mu: 2, sigma: 0.5 },
            ],
          },
        },
        V_MIX,
      ),
      null,
    );
    assert.equal(
      validateModelParams(
        {
          mixture: {
            k: 1,
            components: [{ weight: 0, mu: 1, sigma: 0.5 }],
          },
        },
        V_MIX,
      ),
      null,
    );
    // μ/σ
    assert.equal(
      validateModelParams(
        {
          mixture: { k: 1, components: [{ weight: 1, mu: Number.NaN, sigma: 0.5 }] },
        },
        V_MIX,
      ),
      null,
    );
    assert.equal(
      validateModelParams(
        {
          mixture: { k: 1, components: [{ weight: 1, mu: 1, sigma: 0 }] },
        },
        V_MIX,
      ),
      null,
    );
    assert.equal(validateModelParams({ mixture: 42 }, V_MIX), null);
  });
});

describe("pickModelParams + paramsForPartition", () => {
  it("market exacto manda; si es inválido cae a global; si no, frío", () => {
    const rows = [
      { market_id: "m1", version: V_MIX, params_json: { episode_window_days: 14 } },
      { market_id: null, version: V_MIX, params_json: { episode_window_days: 7 } },
    ];
    assert.equal(pickModelParams(rows, "m1")?.episodeWindowDays, 14);
    assert.equal(pickModelParams(rows, "m2")?.episodeWindowDays, 7);
    assert.equal(pickModelParams(rows, null)?.episodeWindowDays, 7);
    assert.equal(pickModelParams([], "m1"), null);
    // Market inválido ⇒ global, no legacy directo.
    const badMarket = [
      {
        market_id: "m1",
        version: V_MIX,
        params_json: { mixture: { k: 9, components: [] } },
      },
      { market_id: null, version: V_MIX, params_json: { episode_window_days: 7 } },
    ];
    assert.equal(pickModelParams(badMarket, "m1")?.episodeWindowDays, 7);
    // Global inválida ⇒ null (frío).
    assert.equal(
      pickModelParams(
        [{ market_id: null, version: V_MIX, params_json: { mixture: { k: 9, components: [] } } }],
        "m1",
      ),
      null,
    );
    // Versión desconocida en market ⇒ cae a global; si global también es
    // vieja ⇒ frío (P2).
    const oldVersion = [
      { market_id: "m1", version: "mix0:legado", params_json: { episode_window_days: 14 } },
      { market_id: null, version: V_MIX, params_json: { episode_window_days: 7 } },
    ];
    assert.equal(pickModelParams(oldVersion, "m1")?.episodeWindowDays, 7);
    const allOld = [
      { market_id: "m1", version: "mix0:legado", params_json: { episode_window_days: 14 } },
    ];
    assert.equal(pickModelParams(allOld, "m1"), null);
  });

  it("paramsForPartition distingue market/global/arquetipo", () => {
    const byKey = new Map([
      [null, { episodeWindowDays: 7, mixture: null }],
      ["m1", { episodeWindowDays: 14, mixture: null }],
    ]);
    assert.equal(paramsForPartition(byKey, "m1").source, "tienda:market");
    assert.equal(paramsForPartition(byKey, "m2").source, "tienda:global");
    assert.equal(paramsForPartition(new Map(), "m1").source, "arquetipo");
    assert.equal(paramsForPartition(new Map(), null).source, "arquetipo");
  });
});

describe("asValidMixtureFit", () => {
  it("acepta y ordena; rechaza basura", () => {
    const ok = asValidMixtureFit(GOOD.mixture);
    assert.ok(ok !== null && ok.k === 2 && ok.components[0].mu < ok.components[1].mu);
    assert.equal(asValidMixtureFit(null), null);
    assert.equal(asValidMixtureFit({ k: 2, components: [] }), null);
    assert.equal(
      asValidMixtureFit({ k: 1, components: [{ weight: 0.5, mu: 1, sigma: 0.5 }] }),
      null,
    );
  });

  it("rechaza componentes fuera de rango operativo", () => {
    assert.equal(
      asValidMixtureFit({ k: 1, components: [{ weight: 1, mu: 1e100, sigma: 0.5 }] }),
      null,
    );
    assert.equal(
      asValidMixtureFit({ k: 1, components: [{ weight: 1, mu: 3, sigma: 1e-9 }] }),
      null,
    );
    assert.equal(
      asValidMixtureFit({ k: 1, components: [{ weight: 1, mu: -5, sigma: 0.5 }] }),
      null,
    );
  });
});

describe("predictStore con fits explícitos (Paso 3)", () => {
  const mkCustomers = (): CustomerSessions[] => {
    const mk = (id: string, gaps: number[], t: number): CustomerSessions => {
      const last = ASOF - t * DAY;
      const ats = [last];
      for (let i = gaps.length - 1; i >= 0; i -= 1) ats.unshift(ats[0] - gaps[i] * DAY);
      return {
        customerId: id,
        sessions: ats.map((at) => ({ at, ticketMinor: 1000, currency: "PEN" })),
      };
    };
    return [
      mk("rapido", [6, 7, 8], 4),
      mk("lento", [55, 62, 58], 9),
      mk("f1", [], 6),
    ];
  };

  it("fit explícito K=2 activa la mezcla (resp blanda por cliente)", () => {
    const fit = {
      k: 2,
      components: [
        { weight: 0.5, mu: Math.log(7), sigma: 0.4 },
        { weight: 0.5, mu: Math.log(60), sigma: 0.4 },
      ],
    };
    const ev: MixtureEvidence = {};
    const got = predictStore({
      ...baseInput(mkCustomers()),
      mixtureStoreFit: fit,
      mixtureCohortFit: fit,
      mixtureEvidence: ev,
    });
    assert.equal(ev.store?.k, 2);
    assert.equal(ev.cohort?.k, 2);
    const rRapido = ev.respById?.get("rapido") ?? [];
    const rLento = ev.respById?.get("lento") ?? [];
    assert.ok(rRapido[0] > 0.7, `rRapido=${rRapido}`);
    assert.ok(rLento[1] > 0.7, `rLento=${rLento}`);
    for (const p of got) {
      assert.ok(p.pRecompraH >= 0 && p.pRecompraH <= 1);
      assert.equal(p.decisionVersion, "v4:nodormido-exception");
    }
  });

  it("fit explícito inválido ⇒ se ignora (idéntico a legacy)", () => {
    const legacy = predictStore(baseInput(mkCustomers()));
    const ev: MixtureEvidence = {};
    const got = predictStore({
      ...baseInput(mkCustomers()),
      mixtureStoreFit: { k: 9, components: [] },
      mixtureCohortFit: null,
      mixtureEvidence: ev,
    });
    assert.deepEqual(
      got.map((p) => [p.customerId, p.pRecompraH, p.decision]),
      legacy.map((p) => [p.customerId, p.pRecompraH, p.decision]),
    );
    assert.equal(ev.store, null);
  });

  it("fit explícito K=1 ⇒ camino legacy exacto", () => {
    const legacy = predictStore(baseInput(mkCustomers()));
    const ev: MixtureEvidence = {};
    const got = predictStore({
      ...baseInput(mkCustomers()),
      mixtureStoreFit: { k: 1, components: [{ weight: 1, mu: Math.log(30), sigma: 0.5 }] },
      mixtureEvidence: ev,
    });
    assert.deepEqual(
      got.map((p) => [p.customerId, p.pRecompraH, p.pLow, p.pHigh, p.decision, p.model]),
      legacy.map((p) => [p.customerId, p.pRecompraH, p.pLow, p.pHigh, p.decision, p.model]),
    );
  });
});
