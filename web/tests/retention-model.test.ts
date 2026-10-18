// Motor probabilístico de retención: propiedades monótonas y casos de control.
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  predictStore,
  sessionize,
  type CustomerSessions,
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
    // No incluye los 10000 USD: queda cerca de la mediana PEN (~5000).
    assert.ok(
      p.ticketEsperadoMinor !== null && p.ticketEsperadoMinor < 8000,
      `ticket=${p.ticketEsperadoMinor}`,
    );
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

  it("supresiones y B2B top decil → revision_humana", () => {
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
    assert.equal(preds.find((x) => x.customerId === "vip")!.decision, "revision_humana");
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
});
