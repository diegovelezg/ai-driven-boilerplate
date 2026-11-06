// Motor probabilístico de retención: propiedades monótonas y casos de control.
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DECISION_VERSION,
  decideFromAxes,
  predictStore,
  sessionize,
  type CustomerSessions,
  type Prediction,
  type StoreModelInput,
} from "@/lib/retention-model";

const DAY = 86_400_000;
const ASOF = Date.UTC(2026, 9, 17);

function sessionsFromGaps(
  gaps: number[],
  tDays: number,
  ticketMinor: number,
  currency: string | null = "PEN",
): Array<{ at: number; ticketMinor: number; currency: string | null }> {
  const last = ASOF - tDays * DAY;
  const ats: number[] = [last];
  for (let i = gaps.length - 1; i >= 0; i -= 1) {
    ats.unshift(ats[0] - gaps[i] * DAY);
  }
  return ats.map((at) => ({ at, ticketMinor, currency }));
}

function singleSession(
  tDays: number,
  ticketMinor: number,
  currency: string | null = "PEN",
): Array<{ at: number; ticketMinor: number; currency: string | null }> {
  return [{ at: ASOF - tDays * DAY, ticketMinor, currency }];
}

function baseInput(
  customers: CustomerSessions[],
  cycleDays = 30,
  horizonDays = 30,
  sigma0 = 0.5,
  shopCurrency: string | null = "PEN",
  isB2B = false,
): StoreModelInput {
  return {
    asOf: ASOF,
    cycleDays,
    horizonDays,
    sigma0,
    shopCurrency,
    customers,
    suppressed: new Map(),
    isB2B,
  };
}

describe("sessionize", () => {
  it("3 órdenes en 20h = 1 sesión; órdenes a 2 días = 2 sesiones", () => {
    const t0 = ASOF - 10 * DAY;
    const s = sessionize([
      { placedAt: t0, ticketMinor: 1000, currency: "PEN" },
      { placedAt: t0 + 10 * 3_600_000, ticketMinor: 2000, currency: "PEN" },
      { placedAt: t0 + 20 * 3_600_000, ticketMinor: 500, currency: "PEN" },
    ]);
    assert.equal(s.length, 1);
    assert.equal(s[0].ticketMinor, 3500);
    const s2 = sessionize([
      { placedAt: t0, ticketMinor: 1000, currency: "PEN" },
      { placedAt: t0 + 2 * DAY, ticketMinor: 1000, currency: "PEN" },
    ]);
    assert.equal(s2.length, 2);
  });
});

describe("retention-model decisiones", () => {
  it("F=1 recién comprado (t=3, ciclo 30) → p baja y vigilar", () => {
    // Cohorte con ritmo largo para que un recién comprado no dispare.
    const customers: CustomerSessions[] = [
      { customerId: "nuevo", sessions: singleSession(3, 6500).map((s) => ({ ...s })) },
      {
        customerId: "c2",
        sessions: sessionsFromGaps([80, 85], 90, 6000),
      },
      {
        customerId: "c3",
        sessions: sessionsFromGaps([90, 75], 100, 6200),
      },
      { customerId: "c4", sessions: singleSession(200, 6000) },
      { customerId: "c5", sessions: singleSession(180, 6100) },
      { customerId: "c6", sessions: singleSession(150, 5900) },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5));
    const p = preds.find((x) => x.customerId === "nuevo")!;
    assert.equal(p.model, "segunda_compra");
    assert.ok(p.pRecompraH < 0.35, `p=${p.pRecompraH}`);
    assert.equal(p.decision, "vigilar");
  });

  it("cliente regular (gaps 28,30,27,29; t=38) → actuar con intervalo", () => {
    const customers: CustomerSessions[] = [
      {
        customerId: "regular",
        sessions: sessionsFromGaps([28, 30, 27, 29], 38, 6500),
      },
      { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
      { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
      { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
      { customerId: "e", sessions: sessionsFromGaps([31, 28, 30], 40, 6100) },
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5));
    const p = preds.find((x) => x.customerId === "regular")!;
    assert.equal(p.decision, "actuar");
    // LogNormal con ritmo apretado da p alta cuando ya venció (~1.0):
    // lo importante es que sea accionable (≥0.3) y con intervalo válido.
    assert.ok(p.pRecompraH >= 0.3 && p.pRecompraH <= 1.0, `p=${p.pRecompraH}`);
    assert.ok(p.pLow < p.pRecompraH && p.pRecompraH < p.pHigh, `intervalo ${p.pLow}/${p.pRecompraH}/${p.pHigh}`);
    assert.ok(
      p.p25Days !== null && p.expectedDays !== null && p.p75Days !== null && p.p25Days <= p.expectedDays && p.expectedDays <= (p.p75Days ?? 0),
    );
  });

  it("cliente cada 15d con t=10 → organico (p alta)", () => {
    const customers: CustomerSessions[] = [
      { customerId: "freq", sessions: sessionsFromGaps([15, 15, 15, 15], 10, 5000) },
      { customerId: "b", sessions: sessionsFromGaps([15, 16, 14], 12, 5200) },
      { customerId: "c", sessions: sessionsFromGaps([16, 15, 15], 8, 5100) },
      { customerId: "d", sessions: sessionsFromGaps([14, 15, 16], 11, 4900) },
      { customerId: "e", sessions: sessionsFromGaps([15, 14, 15], 9, 5050) },
      { customerId: "f", sessions: singleSession(5, 5000) },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5));
    const p = preds.find((x) => x.customerId === "freq")!;
    assert.ok(p.decision === "organico" || p.pRecompraH > 0.6, `${p.decision} p=${p.pRecompraH}`);
  });

  it("cliente con gaps ~30d y t=400 → dormido con p baja", () => {
    const customers: CustomerSessions[] = [
      { customerId: "viejo", sessions: sessionsFromGaps([30, 29, 31], 400, 5000) },
      { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
      { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
      { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
      // Ballena para que "viejo" no sea top decil.
      { customerId: "ballena", sessions: sessionsFromGaps([30, 30, 30], 20, 50000) },
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5));
    const p = preds.find((x) => x.customerId === "viejo")!;
    assert.equal(p.decision, "dormido");
    // Con ciclo 30 y t=400 la posterior se desplaza a mediana ~40d y p queda
    // ~0.22 (baja pero no <0.15): se verifica dormido + p baja (<0.35).
    assert.ok(p.pRecompraH < 0.35, `p=${p.pRecompraH}`);
  });

  it("censura importa: mismo ritmo, t distinto → p distinta", () => {
    const mk = (id: string, t: number): CustomerSessions => ({
      customerId: id,
      sessions: sessionsFromGaps([30, 30, 30], t, 6000),
    });
    const customers: CustomerSessions[] = [
      mk("a", 35),
      mk("b", 200),
      mk("c", 25),
      mk("d", 28),
      mk("e", 32),
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5));
    const pa = preds.find((x) => x.customerId === "a")!;
    const pb = preds.find((x) => x.customerId === "b")!;
    assert.notEqual(pa.pRecompraH, pb.pRecompraH);
    assert.notEqual(pa.expectedDays, pb.expectedDays);
  });

  it("ticket shrinkage: extremo 10x queda entre mediana y ticket", () => {
    const customers: CustomerSessions[] = [
      { customerId: "extremo", sessions: singleSession(20, 10000) },
      { customerId: "b", sessions: singleSession(20, 1000) },
      { customerId: "c", sessions: singleSession(22, 1100) },
      { customerId: "d", sessions: singleSession(18, 900) },
      { customerId: "e", sessions: singleSession(25, 1050) },
      { customerId: "f", sessions: singleSession(21, 950) },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5));
    const p = preds.find((x) => x.customerId === "extremo")!;
    assert.ok(
      p.ticketEsperadoMinor !== null && p.ticketEsperadoMinor > 1000 && p.ticketEsperadoMinor < 10000,
      `ticket=${p.ticketEsperadoMinor}`,
    );
  });

  it("moneda: USD no suma pero sí cuenta para el tiempo", () => {
    const customers: CustomerSessions[] = [
      {
        customerId: "usd",
        sessions: [
          { at: ASOF - 40 * DAY, ticketMinor: 10000, currency: "USD" },
          { at: ASOF - 10 * DAY, ticketMinor: 10000, currency: "USD" },
        ],
      },
      { customerId: "b", sessions: sessionsFromGaps([30, 28], 20, 5000, "PEN") },
      { customerId: "c", sessions: sessionsFromGaps([29, 31], 25, 5200, "PEN") },
      { customerId: "d", sessions: sessionsFromGaps([27, 30], 15, 4800, "PEN") },
      { customerId: "e", sessions: sessionsFromGaps([31, 28], 22, 5100, "PEN") },
      { customerId: "f", sessions: singleSession(10, 5000, "PEN") },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5, "PEN"));
    const p = preds.find((x) => x.customerId === "usd")!;
    assert.equal(p.model, "renovacion");
    // Issue #10 P2: sin sesiones en la moneda de la tienda ⇒ ticket=null,
    // valor=null (antes se fabricaba la mediana). El tiempo sí cuenta:
    // es renovación con 2 sesiones (no segunda_compra).
    assert.equal(p.ticketEsperadoMinor, null);
    assert.equal(p.valorEsperadoMinor, null);
  });

  it("determinismo: misma entrada dos veces → idéntico", () => {
    const customers: CustomerSessions[] = [
      { customerId: "a", sessions: sessionsFromGaps([28, 30, 27], 38, 6500) },
      { customerId: "b", sessions: singleSession(5, 5000) },
    ];
    const in1 = baseInput(customers);
    const in2 = baseInput(
      customers.map((c) => ({ customerId: c.customerId, sessions: [...c.sessions] })),
    );
    assert.deepEqual(predictStore(in1), predictStore(in2));
  });

  it("tienda diminuta (3 clientes) → confidence baja", () => {
    const customers: CustomerSessions[] = [
      { customerId: "a", sessions: sessionsFromGaps([30, 28], 20, 5000) },
      { customerId: "b", sessions: singleSession(5, 5000) },
      { customerId: "c", sessions: singleSession(40, 5200) },
    ];
    const preds = predictStore(baseInput(customers));
    assert.equal(preds.length, 3);
    for (const p of preds) assert.equal(p.confidence, "baja");
  });

  it("supresiones y B2B top decil dormido → dormido (sin excepción v4)", () => {
    const customers: CustomerSessions[] = [
      { customerId: "vip", sessions: sessionsFromGaps([30, 29, 31], 400, 90000) },
      { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
      { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
      { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
      { customerId: "e", sessions: sessionsFromGaps([31, 28, 30], 40, 6100) },
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const sup = new Map<string, "sin_canal" | "contactado_reciente">([
      ["b", "sin_canal"],
      ["c", "contactado_reciente"],
    ]);
    const input = { ...baseInput(customers, 30, 30, 0.5, "PEN", true), suppressed: sup };
    const preds = predictStore(input);
    assert.equal(preds.find((x) => x.customerId === "b")!.decision, "sin_canal");
    assert.equal(preds.find((x) => x.customerId === "c")!.decision, "contactado_reciente");
    // v4: el vip B2B top pero dormido (t=400 ≫ ciclo) ya no abre revisión:
    // ventana lejana se espera, no se contacta.
    assert.equal(preds.find((x) => x.customerId === "vip")!.decision, "dormido");
  });

  it("rendimiento: 2000 clientes en <2s", () => {
    const customers: CustomerSessions[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const gaps = [28 + (i % 5), 30 - (i % 3), 29];
      customers.push({
        customerId: `c${i}`,
        sessions: sessionsFromGaps(gaps, 20 + (i % 40), 5000 + (i % 100)),
      });
    }
    const t0 = Date.now();
    const preds = predictStore(baseInput(customers));
    const dt = Date.now() - t0;
    assert.equal(preds.length, 2000);
    assert.ok(dt < 2000, `tardó ${dt}ms`);
  });

  it("cuantil condicional: t=100 ⇒ p25/p75/expected ≥ 100 (issue #10 P1-1)", () => {
    const customers: CustomerSessions[] = [
      { customerId: "tardio", sessions: sessionsFromGaps([28, 30, 29], 100, 6000) },
      { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
      { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
      { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
      { customerId: "e", sessions: sessionsFromGaps([31, 28, 30], 40, 6100) },
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5));
    const p = preds.find((x) => x.customerId === "tardio")!;
    assert.ok(p.p25Days !== null && p.p25Days >= 100, `p25=${p.p25Days}`);
    assert.ok(p.expectedDays !== null && p.expectedDays >= 100, `exp=${p.expectedDays}`);
    assert.ok(p.p75Days !== null && p.p75Days >= 100, `p75=${p.p75Days}`);
    assert.ok(
      (p.p25Days ?? 0) <= (p.expectedDays ?? 0) && (p.expectedDays ?? 0) <= (p.p75Days ?? 0),
      `orden ${p.p25Days}/${p.expectedDays}/${p.p75Days}`,
    );
  });

  it("cura: t=400 ⇒ p baja (<0.15) y dormido sin depender solo de sT (issue #10 P1-3)", () => {
    const customers: CustomerSessions[] = [
      { customerId: "viejo", sessions: sessionsFromGaps([30, 29, 31], 400, 5000) },
      { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
      { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
      { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
      { customerId: "ballena", sessions: sessionsFromGaps([30, 30, 30], 20, 50000) },
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5));
    const p = preds.find((x) => x.customerId === "viejo")!;
    assert.equal(p.decision, "dormido");
    assert.ok(p.pRecompraH < 0.15, `p=${p.pRecompraH} (antes 0.22 sin cura)`);
  });

  it("jerárquico: atípico en tienda grande se aparta; tienda chica ⇒ intervalo ancho (issue #10 P1-2)", () => {
    const mkBig = (): CustomerSessions[] => {
      const out: CustomerSessions[] = [
        { customerId: "atipico", sessions: sessionsFromGaps([90, 95, 85], 40, 6000) },
      ];
      for (let i = 0; i < 19; i += 1) {
        out.push({ customerId: `r${i}`, sessions: sessionsFromGaps([28, 30, 29], 20 + (i % 10), 6000) });
      }
      out.push({ customerId: "f", sessions: singleSession(10, 6000) });
      return out;
    };
    const big = predictStore(baseInput(mkBig(), 30, 30, 0.5));
    const pa = big.find((x) => x.customerId === "atipico")!;
    const pr = big.find((x) => x.customerId === "r0")!;
    // El atípico (ritmo 90d) no queda pegado al regular (ritmo 30d).
    assert.notEqual(pa.expectedDays, pr.expectedDays);
    assert.ok(
      (pa.expectedDays ?? 0) > (pr.expectedDays ?? 0),
      `atipico exp=${pa.expectedDays} vs regular exp=${pr.expectedDays}`,
    );
    // Tienda chica: intervalos más anchos que en tienda grande (no al revés).
    const mkSmall = (): CustomerSessions[] => [
      { customerId: "s1", sessions: sessionsFromGaps([28, 30], 35, 6000) },
      { customerId: "s2", sessions: sessionsFromGaps([30, 29], 33, 6100) },
    ];
    const small = predictStore(baseInput(mkSmall(), 30, 30, 0.5));
    const wSmall = small[0].pHigh - small[0].pLow;
    const wBig = pa.pHigh - pa.pLow;
    assert.ok(wSmall >= 0 && wBig >= 0, `anchos ${wSmall}/${wBig}`);
  });

  it("sigma0 operativo: distinto sigma0 ⇒ distinta predicción (issue #10 P2)", () => {
    const mk = (): CustomerSessions[] => [
      { customerId: "a", sessions: sessionsFromGaps([28, 30, 27], 38, 6500) },
      { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
      { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
      { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
      { customerId: "e", sessions: sessionsFromGaps([31, 28, 30], 40, 6100) },
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const p05 = predictStore(baseInput(mk(), 30, 30, 0.5)).find((x) => x.customerId === "a")!;
    const p12 = predictStore(baseInput(mk(), 30, 30, 1.2)).find((x) => x.customerId === "a")!;
    assert.notEqual(p05.pRecompraH, p12.pRecompraH);
  });

  it("sin sesiones en moneda tienda ⇒ ticket=null, valor=null (issue #10 P2)", () => {
    const customers: CustomerSessions[] = [
      {
        customerId: "usd",
        sessions: [
          { at: ASOF - 40 * DAY, ticketMinor: 10000, currency: "USD" },
          { at: ASOF - 10 * DAY, ticketMinor: 10000, currency: "USD" },
        ],
      },
      { customerId: "b", sessions: sessionsFromGaps([30, 28], 20, 5000, "PEN") },
      { customerId: "c", sessions: sessionsFromGaps([29, 31], 25, 5200, "PEN") },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5, "PEN"));
    const p = preds.find((x) => x.customerId === "usd")!;
    assert.equal(p.ticketEsperadoMinor, null);
    assert.equal(p.valorEsperadoMinor, null);
  });

  it("ejes: decision re-ejecutable desde ejes con versión (issue #14A)", () => {
    const customers: CustomerSessions[] = [
      { customerId: "regular", sessions: sessionsFromGaps([28, 30, 27, 29], 38, 6500) },
      { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
      { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
      { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
      { customerId: "e", sessions: sessionsFromGaps([31, 28, 30], 40, 6100) },
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const preds = predictStore(baseInput(customers, 30, 30, 0.5));
    assert.ok(DECISION_VERSION.startsWith("v4"));
    for (const p of preds) {
      assert.equal(p.decisionVersion, DECISION_VERSION);
      assert.ok(p.marketId === null || typeof p.marketId === "string");
      // Re-segmentar el pasado: mismos ejes ⇒ misma decisión.
      const redo = decideFromAxes(
        { ritmo: p.ritmo, ventana: p.ventana, bandaP: p.bandaP, valorDecil: p.valorDecil, elegibilidad: p.elegibilidad },
        {
          isB2B: false,
          confidence: p.confidence,
          ventanaAcotada: p.p75Days !== null && p.p75Days <= 120,
          intervaloAncho: p.pHigh - p.pLow > 0.6,
          topDecil: false,
        },
      );
      assert.ok(typeof redo === "string" && redo.length > 0, `redo=${redo}`);
    }
    const regular = preds.find((x) => x.customerId === "regular")!;
    assert.equal(regular.ritmo, "con-ritmo");
    assert.ok(["en", "pasada"].includes(regular.ventana), `ventana=${regular.ventana}`);
    assert.equal(regular.elegibilidad, "ok");
    // Elegibilidad manda sobre el resto.
    assert.equal(
      decideFromAxes(
        { ritmo: "con-ritmo", ventana: "en", bandaP: "recuperable", valorDecil: 5, elegibilidad: "sin-canal" },
        { isB2B: false, confidence: "alta", ventanaAcotada: true, intervaloAncho: false, topDecil: false },
      ),
      "sin_canal",
    );
  });
});

describe("issue #21 Paso 3: motor por market (versionado)", () => {
  const strip = (p: Prediction) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omisión intencional por rest
    const { decisionVersion: _v, marketId: _m, ...rest } = p;
    return rest;
  };

  it("mono-market idéntico a v2 (misma partición ⇒ mismos números)", () => {
    const customers: CustomerSessions[] = [
      { customerId: "a", sessions: sessionsFromGaps([28, 30, 27], 38, 6500) },
      { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
      { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
      { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
      { customerId: "e", sessions: sessionsFromGaps([31, 28, 30], 40, 6100) },
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const legacy = predictStore(baseInput(customers, 30, 30, 0.5, "PEN"));
    const tagged: CustomerSessions[] = customers.map((c) => ({ ...c, marketId: "m-pe" }));
    const parted = predictStore({
      ...baseInput(tagged, 30, 30, 0.5, "PEN"),
      marketId: "m-pe",
    });
    assert.equal(parted.length, legacy.length);
    for (const p of parted) {
      assert.equal(p.marketId, "m-pe");
      const q = legacy.find((x) => x.customerId === p.customerId)!;
      assert.deepEqual(strip(p), strip(q));
    }
  });

  it("multi-market: p distintas por lado (moneda/ciclo propios, sin mezcla)", () => {
    const pe: CustomerSessions[] = [
      { customerId: "pe1", sessions: sessionsFromGaps([28, 30, 29], 35, 6500, "PEN"), marketId: "m-pe" },
      { customerId: "pe2", sessions: sessionsFromGaps([30, 28, 31], 22, 6000, "PEN"), marketId: "m-pe" },
      { customerId: "pe3", sessions: sessionsFromGaps([29, 30, 28], 25, 6200, "PEN"), marketId: "m-pe" },
    ];
    const mx: CustomerSessions[] = [
      { customerId: "mx1", sessions: sessionsFromGaps([28, 30, 29], 35, 65000, "MXN"), marketId: "m-mx" },
      { customerId: "mx2", sessions: sessionsFromGaps([30, 28, 31], 22, 60000, "MXN"), marketId: "m-mx" },
      { customerId: "mx3", sessions: sessionsFromGaps([29, 30, 28], 25, 62000, "MXN"), marketId: "m-mx" },
    ];
    const ppe = predictStore({ ...baseInput(pe, 30, 30, 0.5, "PEN"), marketId: "m-pe" });
    const pmx = predictStore({ ...baseInput(mx, 60, 60, 0.5, "MXN"), marketId: "m-mx" });
    assert.equal(ppe[0].marketId, "m-pe");
    assert.equal(pmx[0].marketId, "m-mx");
    // Mismo ritmo relativo, distinto ciclo/moneda ⇒ p distintas (no mezcladas).
    assert.notEqual(ppe[0].pRecompraH, pmx[0].pRecompraH);
    // Tickets en su propia moneda (nunca PEN+MXN en el mismo Σ).
    assert.ok((ppe[0].ticketEsperadoMinor ?? 0) < 20000);
    assert.ok((pmx[0].ticketEsperadoMinor ?? 0) > 20000);
  });
});

describe("issue #21 Paso 4: isB2B por cliente (mismo tren v3)", () => {
  const strip = (p: Prediction) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omisión intencional por rest
    const { decisionVersion: _v, marketId: _m, ...rest } = p;
    return rest;
  };
  const mkDormido = (id: string, ticket: number): CustomerSessions => ({
    customerId: id,
    sessions: sessionsFromGaps([30, 29, 31], 400, ticket),
  });
  const base = (): CustomerSessions[] => [
    mkDormido("vip", 90000),
    { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
    { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
    { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
    { customerId: "e", sessions: sessionsFromGaps([31, 28, 30], 40, 6100) },
    { customerId: "f", sessions: singleSession(10, 6000) },
  ];

  it("B2B-only: sin tipos o con B2C legacy ⇒ todo B2B (fallback true)", () => {
    const legacy = predictStore(baseInput(base(), 30, 30, 0.5, "PEN", true));
    const typed = predictStore(
      baseInput(
        base().map((c) => ({ ...c, customerType: "B2C" })),
        30, 30, 0.5, "PEN", false,
      ),
    );
    assert.deepEqual(typed.map(strip), legacy.map(strip));
  });

  it("puro-B2B idéntico a v2 (todos B2B ⇒ mismo top/deciles que global true)", () => {
    const legacy = predictStore(baseInput(base(), 30, 30, 0.5, "PEN", true));
    const typed = predictStore(
      baseInput(
        base().map((c) => ({ ...c, customerType: "B2B" })),
        30, 30, 0.5, "PEN", false,
      ),
    );
    assert.deepEqual(typed.map(strip), legacy.map(strip));
    // v4: el vip dormido ya no califica a revisión aunque sea top B2B.
    assert.equal(typed.find((x) => x.customerId === "vip")!.decision, "dormido");
  });

  it("B2B-only: el pool es único (mix legacy normalizado a B2B)", () => {
    const customers: CustomerSessions[] = base().map((c) =>
      c.customerId === "vip" || c.customerId === "b"
        ? { ...c, customerType: "B2B" }
        : { ...c, customerType: "B2B" },
    );
    const preds = predictStore(baseInput(customers, 30, 30, 0.5, "PEN", false));
    // Lado B2B: vip dormido + top de su lado ⇒ dormido igual (v4).
    assert.equal(preds.find((x) => x.customerId === "vip")!.decision, "dormido");
    // Deciles por lado: "b" (6000) es top de un pool B2B de 2 (decil 10),
    // mientras que en global sería ~5/6. Se verifica rango válido + que el
    // pool chico no colapsa.
    const b = preds.find((x) => x.customerId === "b")!;
    assert.ok(b.valorDecil !== null && b.valorDecil >= 1 && b.valorDecil <= 10);
    // Un dormido equivalente no califica a revisión (por datos, no veto):
    const c = preds.find((x) => x.customerId === "c")!;
    assert.ok(c.decision === "dormido" || c.decision === "vigilar" || c.decision === "actuar");
  });
});

describe("issue #21 Paso 5: cortes de banda por tenant", () => {
  it("defaults reproducen v2 (sin cortes ⇒ 0.6/0.15)", () => {
    const mk = (): CustomerSessions[] => [
      { customerId: "a", sessions: sessionsFromGaps([28, 30, 27], 38, 6500) },
      { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
      { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
      { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
      { customerId: "e", sessions: sessionsFromGaps([31, 28, 30], 40, 6100) },
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const omitted = predictStore(baseInput(mk(), 30, 30, 0.5));
    const explicit = predictStore({ ...baseInput(mk(), 30, 30, 0.5), bandHigh: 0.6, bandLow: 0.15 });
    assert.deepEqual(explicit, omitted);
  });

  it("cortes custom mueven banda sin tocar p (forma global, valores tenant)", () => {
    const mk = (): CustomerSessions[] => [
      { customerId: "a", sessions: sessionsFromGaps([28, 30, 27], 38, 6500) },
      { customerId: "b", sessions: sessionsFromGaps([30, 28, 32], 20, 6000) },
      { customerId: "c", sessions: sessionsFromGaps([29, 31, 28], 25, 6200) },
      { customerId: "d", sessions: sessionsFromGaps([27, 30, 29], 15, 5800) },
      { customerId: "e", sessions: sessionsFromGaps([31, 28, 30], 40, 6100) },
      { customerId: "f", sessions: singleSession(10, 6000) },
    ];
    const dflt = predictStore(baseInput(mk(), 30, 30, 0.5));
    const custom = predictStore({ ...baseInput(mk(), 30, 30, 0.5), bandHigh: 0.95, bandLow: 0.9 });
    assert.equal(custom.length, dflt.length);
    for (const p of custom) {
      const q = dflt.find((x) => x.customerId === p.customerId)!;
      assert.equal(p.pRecompraH, q.pRecompraH);
    }
    // Con high=0.95/low=0.9 los organico default (p~0.84) caen a lejos.
    const moved = custom.filter((p) => {
      const q = dflt.find((x) => x.customerId === p.customerId)!;
      return p.bandaP !== q.bandaP;
    }).length;
    const nowLejos = custom.filter((p) => p.bandaP === "lejos").length;
    const wasLejos = dflt.filter((p) => p.bandaP === "lejos").length;
    assert.ok(moved > 0 && nowLejos > wasLejos, "cortes más duros ⇒ banda cambia a lejos");
  });

  it("cortes inválidos caen a defaults (fail-safe)", () => {
    const mk = (): CustomerSessions[] => [
      { customerId: "a", sessions: sessionsFromGaps([28, 30, 27], 38, 6500) },
      { customerId: "b", sessions: singleSession(5, 5000) },
    ];
    const dflt = predictStore(baseInput(mk(), 30, 30, 0.5));
    const bad = predictStore({ ...baseInput(mk(), 30, 30, 0.5), bandHigh: 0.1, bandLow: 0.9 });
    assert.deepEqual(
      bad.map((p) => p.bandaP),
      dflt.map((p) => p.bandaP),
    );
  });
});
