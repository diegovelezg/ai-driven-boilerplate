// Anti-sobreventa: solape de rangos, frescura del hold y bordes de periodo.
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HOLD_DAYS,
  displayEndOf,
  isHoldFresh,
  periodBounds,
  rangesOverlap,
} from "../lib/availability";

describe("rangesOverlap (semiabierto [inicio,fin))", () => {
  it("detecta solape parcial y contenido", () => {
    assert.equal(rangesOverlap("a", "c", "b", "d"), true);
    assert.equal(rangesOverlap("b", "d", "a", "c"), true);
    assert.equal(rangesOverlap("a", "d", "b", "c"), true);
  });
  it("adyacentes no solapan (fin exclusivo)", () => {
    assert.equal(rangesOverlap("a", "b", "b", "c"), false);
    assert.equal(rangesOverlap("b", "c", "a", "b"), false);
  });
  it("idénticos solapan", () => {
    assert.equal(rangesOverlap("a", "b", "a", "b"), true);
  });
});

describe("isHoldFresh (borrador aparta HOLD_DAYS)", () => {
  it("fresco dentro de la ventana", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    assert.equal(isHoldFresh("2026-11-01T12:00:00Z", now), true);
  });
  it("vencido libera", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    assert.equal(isHoldFresh("2026-10-01T12:00:00Z", now), false);
  });
  it(`HOLD_DAYS es 7`, () => {
    assert.equal(HOLD_DAYS, 7);
  });
  it("sin fecha no aparta", () => {
    assert.equal(isHoldFresh(null), false);
    assert.equal(isHoldFresh("no-fecha"), false);
  });
});

describe("bordes de periodo UI ↔ BD", () => {
  it("periodBounds: fin inclusivo → exclusivo día siguiente Lima", () => {
    const { qStart, qEnd } = periodBounds("2026-11-03", "2026-11-24");
    assert.equal(qStart, "2026-11-03T00:00:00-05:00");
    assert.equal(qEnd, "2026-11-25T00:00:00-05:00");
  });
  it("displayEndOf: fin exclusivo → día inclusivo", () => {
    assert.equal(displayEndOf("2026-11-25T00:00:00-05:00"), "2026-11-24");
  });
});
