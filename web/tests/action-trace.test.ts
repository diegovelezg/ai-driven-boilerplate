// Issue #19: semántica del feed de enviados y etiqueta de aprobador.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { approverLabel, dispatchedOutcome } from "@/lib/action-trace";

const SENT = "2026-10-01T12:00:00.000Z";
const sentMs = Date.parse(SENT);

describe("dispatchedOutcome", () => {
  it("revenue > 0 → volvió, aunque la ventana siga abierta", () => {
    const o = dispatchedOutcome({ dispatchedAt: SENT, revenueAttributed: 5000, windowDays: 14, nowMs: sentMs + 86_400_000 });
    assert.deepEqual(o, { kind: "volvio", revenue: 5000 });
  });

  it("revenue null + ventana abierta → en ventana, nunca no_volvio", () => {
    const o = dispatchedOutcome({ dispatchedAt: SENT, revenueAttributed: null, windowDays: 14, nowMs: sentMs + 4 * 86_400_000 });
    assert.deepEqual(o, { kind: "en_ventana", daysLeft: 10 });
  });

  it("ventana cerrada sin compra → no volvió", () => {
    const o = dispatchedOutcome({ dispatchedAt: SENT, revenueAttributed: 0, windowDays: 14, nowMs: sentMs + 15 * 86_400_000 });
    assert.deepEqual(o, { kind: "no_volvio" });
  });

  it("sin dispatched_at → null", () => {
    assert.equal(dispatchedOutcome({ dispatchedAt: null, revenueAttributed: null, windowDays: 14, nowMs: sentMs }), null);
  });
});

describe("approverLabel", () => {
  it("sin registro nunca inventa un nombre", () => {
    assert.equal(approverLabel(null), "sin registro");
    assert.equal(approverLabel("  "), "sin registro");
    assert.equal(approverLabel("a@b.com"), "a@b.com");
  });
});
