// Episodización por tenant (issue #27 Paso 1): unidad de análisis episodio.
// Corre con: npx tsx --test tests/episodeize.test.ts
import { describe, it } from "node:test";
import assert from "assert/strict";
import {
  EPISODE_VERSION,
  asValidEpisodeWindowDays,
  episodeize,
  predictStore,
  sessionize,
  type CustomerSessions,
  type StoreModelInput,
} from "@/lib/retention-model";

const DAY = 86_400_000;
const ASOF = Date.UTC(2026, 9, 17);

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

describe("episodeize (issue #27 Paso 1)", () => {
  it("ráfaga de 5 sesiones en 5 días con ventana 14 → 1 episodio", () => {
    const orders = [0, 1, 2, 3, 4].map((d) => ({
      at: ASOF - 50 * DAY + d * DAY,
      ticketMinor: 1000,
      currency: "PEN" as const,
    }));
    const sessions = sessionize(
      orders.map((o) => ({ placedAt: o.at, ticketMinor: o.ticketMinor, currency: o.currency })),
    );
    assert.equal(sessions.length, 5);
    const eps = episodeize(sessions, 14, null);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].sessionCount, 5);
    assert.equal(eps[0].startAt, sessions[0].at);
    assert.equal(eps[0].endAt, sessions[4].at);
    assert.equal(eps[0].ticketMinor, 5000);
  });

  it("consumo diario sintético con ventana pequeña reproduce sesiones", () => {
    const orders = [40, 30, 20, 10].map((t) => ({
      placedAt: ASOF - t * DAY,
      ticketMinor: 500,
      currency: "PEN" as const,
    }));
    const sessions = sessionize(orders);
    assert.equal(sessions.length, 4);
    const eps = episodeize(sessions, 2, null);
    assert.equal(eps.length, 4);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(eps[i].startAt, sessions[i].at);
      assert.equal(eps[i].endAt, sessions[i].at);
    }
  });

  it("default (null/<=1) no fusiona: idéntico al comportamiento actual", () => {
    const orders = [12, 5, 1].map((t) => ({
      placedAt: ASOF - t * DAY,
      ticketMinor: 700,
      currency: "PEN" as const,
    }));
    const sessions = sessionize(orders);
    for (const w of [null, undefined, 0, 1, -3, Number.NaN]) {
      const eps = episodeize(sessions, w as number | null, null);
      assert.equal(eps.length, sessions.length);
    }
  });

  it("misma windowKey fusiona aunque el gap supere la ventana; distinta no", () => {
    const sessions = [
      { at: ASOF - 100 * DAY, ticketMinor: 1000, currency: "PEN" as const },
      { at: ASOF - 10 * DAY, ticketMinor: 1000, currency: "PEN" as const },
    ];
    const same = episodeize(sessions, null, ["camp-A", "camp-A"]);
    assert.equal(same.length, 1);
    const diff = episodeize(sessions, null, ["camp-A", "camp-B"]);
    assert.equal(diff.length, 2);
  });

  it("t sale del fin del último episodio y gaps entre episodios", () => {
    const sessions = [
      { at: ASOF - 60 * DAY, ticketMinor: 1000, currency: "PEN" as const },
      { at: ASOF - 59 * DAY, ticketMinor: 1000, currency: "PEN" as const },
      { at: ASOF - 10 * DAY, ticketMinor: 1000, currency: "PEN" as const },
    ];
    const eps = episodeize(sessions, 7, null);
    assert.equal(eps.length, 2);
    // gap entre episodios = siguiente.start - previo.end = 49 días
    assert.equal((eps[1].startAt - eps[0].endAt) / DAY, 49);
    // t desde el fin del último episodio = 10 días
    assert.equal((ASOF - eps[1].endAt) / DAY, 10);
  });

  it("predictStore sin ventana es idéntico a legacy (K=1 reproduce actual)", () => {
    const mk = (id: string, gaps: number[], t: number): CustomerSessions => {
      const last = ASOF - t * DAY;
      const ats = [last];
      for (let i = gaps.length - 1; i >= 0; i -= 1) ats.unshift(ats[0] - gaps[i] * DAY);
      return {
        customerId: id,
        sessions: ats.map((at) => ({ at, ticketMinor: 1000, currency: "PEN" })),
      };
    };
    const customers = [
      mk("a", [28, 30], 38),
      mk("b", [15], 20),
      mk("c", [], 5),
      mk("d", [28, 30, 32], 400),
    ];
    const legacy = predictStore(baseInput(customers));
    for (const flag of [null, undefined, 1]) {
      const input = baseInput(customers);
      if (flag !== undefined) input.episodeGapDays = flag;
      const got = predictStore(input);
      assert.deepEqual(
        got.map((p) => [p.customerId, p.pRecompraH, p.decision]),
        legacy.map((p) => [p.customerId, p.pRecompraH, p.decision]),
      );
    }
  });

  it("ventana 14 colapsa la ráfaga: F=5 sesiones → F=1 episodio (segunda_compra)", () => {
    const ats = [0, 1, 2, 3, 4].map((d) => ASOF - 50 * DAY + d * DAY);
    const customers: CustomerSessions[] = [
      { customerId: "burst", sessions: ats.map((at) => ({ at, ticketMinor: 1000, currency: "PEN" })) },
    ];
    const legacy = predictStore(baseInput(customers));
    const episodic = predictStore({ ...baseInput(customers), episodeGapDays: 14 });
    assert.equal(legacy[0].model, "renovacion");
    assert.equal(episodic[0].model, "segunda_compra");
  });

  it("expone EPISODE_VERSION auditable", () => {
    assert.equal(EPISODE_VERSION, "ep1:gap-keys");
  });

  it("encadenado single-link: diaria 60d con ventana 14 ⇒ 1 episodio (documenta transitividad)", () => {
    const sessions = Array.from({ length: 60 }, (_, d) => ({
      at: ASOF - 100 * DAY + d * DAY,
      ticketMinor: 500,
      currency: "PEN" as const,
    }));
    const eps = episodeize(sessions, 14, null);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].sessionCount, 60);
    assert.equal(eps[0].startAt, sessions[0].at);
    assert.equal(eps[0].endAt, sessions[59].at);
  });

  it("moneda mixta: fusiona fecha pero conserva ticket de la primera", () => {
    const sessions = [
      { at: ASOF - 10 * DAY, ticketMinor: 1000, currency: "PEN" as const },
      { at: ASOF - 9 * DAY, ticketMinor: 2000, currency: "USD" as const },
    ];
    const eps = episodeize(sessions, 14, null);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].sessionCount, 2);
    assert.equal(eps[0].ticketMinor, 1000);
    assert.equal(eps[0].currency, "PEN");
  });

  it('keys "" ≡ null: no fusionan por ventana declarada', () => {
    const sessions = [
      { at: ASOF - 100 * DAY, ticketMinor: 1000, currency: "PEN" as const },
      { at: ASOF - 10 * DAY, ticketMinor: 1000, currency: "PEN" as const },
    ];
    assert.equal(episodeize(sessions, null, ["", ""]).length, 2);
    assert.equal(episodeize(sessions, null, ["", "camp"]).length, 2);
  });

  it("at duplicado no rompe: gaps ignoran el 0", () => {
    const sessions = [
      { at: ASOF - 10 * DAY, ticketMinor: 1000, currency: "PEN" as const },
      { at: ASOF - 10 * DAY, ticketMinor: 1000, currency: "PEN" as const },
      { at: ASOF - 40 * DAY, ticketMinor: 1000, currency: "PEN" as const },
    ];
    const eps = episodeize(sessions, null, null);
    assert.equal(eps.length, 3);
  });

  it("keys sobreviven al filtrado de at no finitos (alineación pre-sort)", () => {
    const sessions = [
      { at: ASOF - 100 * DAY, ticketMinor: 1000, currency: "PEN" as const },
      { at: Number.NaN, ticketMinor: 1000, currency: "PEN" as const },
      { at: ASOF - 10 * DAY, ticketMinor: 1000, currency: "PEN" as const },
    ];
    const eps = episodeize(sessions, null, ["camp-A", "basura", "camp-A"]);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].sessionCount, 2);
  });
});

describe("asValidEpisodeWindowDays (review Pasos 1-3: el núcleo se autodefiende)", () => {
  it("acepta (1,60]; lo demás ⇒ null (legacy)", () => {
    assert.equal(asValidEpisodeWindowDays(2), 2);
    assert.equal(asValidEpisodeWindowDays(14), 14);
    assert.equal(asValidEpisodeWindowDays(60), 60);
    assert.equal(asValidEpisodeWindowDays(null), null);
    assert.equal(asValidEpisodeWindowDays(undefined), null);
    assert.equal(asValidEpisodeWindowDays(1), null);
    assert.equal(asValidEpisodeWindowDays(0), null);
    assert.equal(asValidEpisodeWindowDays(61), null);
    assert.equal(asValidEpisodeWindowDays(1e12), null);
    assert.equal(asValidEpisodeWindowDays(Number.NaN), null);
    assert.equal(asValidEpisodeWindowDays("14" as unknown as number), null);
  });

  it("episodeize con ventana >60 no fusiona (no colapsa el año en 1 episodio)", () => {
    const sessions = [100, 90, 20, 10].map((t) => ({
      at: ASOF - t * DAY,
      ticketMinor: 1000,
      currency: "PEN" as const,
    }));
    assert.equal(episodeize(sessions, 1e12, null).length, sessions.length);
    assert.equal(episodeize(sessions, 61, null).length, sessions.length);
  });

  it("keys mandan sobre ventana absurda: windowKeys iguales fusionan aunque windowDays>60", () => {
    // El techo 60 solo capa la fusión temporal (a); la fusión por ventana
    // declarada (b) es independiente: nadie debe "arreglarlo" por accidente.
    const sessions = [
      { at: ASOF - 100 * DAY, ticketMinor: 1000, currency: "PEN" as const },
      { at: ASOF - 10 * DAY, ticketMinor: 1000, currency: "PEN" as const },
    ];
    const eps = episodeize(sessions, 1e12, ["camp-A", "camp-A"]);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].sessionCount, 2);
    // Y sin keys, la misma ventana absurda no fusiona.
    assert.equal(episodeize(sessions, 1e12, null).length, 2);
    assert.equal(episodeize(sessions, 1e12, ["camp-A", "camp-B"]).length, 2);
  });

  it("predictStore con episodeGapDays absurdo ⇒ idéntico a legacy", () => {
    const mk = (id: string, gaps: number[], t: number): CustomerSessions => {
      const last = ASOF - t * DAY;
      const ats = [last];
      for (let i = gaps.length - 1; i >= 0; i -= 1) ats.unshift(ats[0] - gaps[i] * DAY);
      return {
        customerId: id,
        sessions: ats.map((at) => ({ at, ticketMinor: 1000, currency: "PEN" })),
      };
    };
    const customers = [mk("a", [10, 12], 8), mk("b", [40], 20)];
    const legacy = predictStore(baseInput(customers));
    const got = predictStore({ ...baseInput(customers), episodeGapDays: 1e12 });
    assert.deepEqual(
      got.map((p) => [p.customerId, p.pRecompraH, p.decision, p.model]),
      legacy.map((p) => [p.customerId, p.pRecompraH, p.decision, p.model]),
    );
  });
});
