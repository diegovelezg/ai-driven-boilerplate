// Puerta pre-envío (issue #13): regla pura de revalidación.
// Corre con: npm test (node:test stdlib via tsx). Solo lógica pura.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePreSend } from "@/lib/pre-send-rule";

const CLEAN = {
  optedOut: false,
  repurchasedSinceApproval: false,
  signalDismissed: false,
  contactedRecentlyElsewhere: false,
  failOpen: false,
  predictionSendable: null as boolean | null,
};

describe("evaluatePreSend", () => {
  it("todo limpio ⇒ enviar", () => {
    assert.deepEqual(evaluatePreSend(CLEAN), { send: true });
  });

  it("predicción enviable explícita ⇒ enviar", () => {
    assert.deepEqual(evaluatePreSend({ ...CLEAN, predictionSendable: true }), { send: true });
  });

  it("opt-out ⇒ skip terminal (nunca enviable)", () => {
    const r = evaluatePreSend({ ...CLEAN, optedOut: true });
    assert.equal(r.send, false);
    if (!r.send) {
      assert.equal(r.terminal, true);
      assert.equal(r.code, "opt_out");
    }
  });

  it("recompra tras aprobar ⇒ skip (test del issue)", () => {
    const r = evaluatePreSend({ ...CLEAN, repurchasedSinceApproval: true });
    assert.equal(r.send, false);
    if (!r.send) {
      assert.equal(r.terminal, true);
      assert.equal(r.code, "repurchased");
    }
  });

  it("señal descartada ⇒ skip", () => {
    const r = evaluatePreSend({ ...CLEAN, signalDismissed: true });
    assert.equal(r.send, false);
    if (!r.send) {
      assert.equal(r.terminal, true);
      assert.equal(r.code, "signal_dismissed");
    }
  });

  it("otro envío reciente ⇒ skip (no duplicar)", () => {
    const r = evaluatePreSend({ ...CLEAN, contactedRecentlyElsewhere: true });
    assert.equal(r.send, false);
    if (!r.send) {
      assert.equal(r.terminal, true);
      assert.equal(r.code, "contactado_reciente");
    }
  });

  it("juez fail-open ⇒ hold, no auto-envío (test del issue)", () => {
    const r = evaluatePreSend({ ...CLEAN, failOpen: true });
    assert.equal(r.send, false);
    if (!r.send) {
      assert.equal(r.terminal, false);
      assert.equal(r.code, "fail_open");
    }
  });

  it("predicción ya no enviable ⇒ hold (ojo humano, no archivo)", () => {
    const r = evaluatePreSend({ ...CLEAN, predictionSendable: false });
    assert.equal(r.send, false);
    if (!r.send) {
      assert.equal(r.terminal, false);
      assert.equal(r.code, "stale_prediction");
    }
  });

  it("prioridad: opt-out manda sobre recompra y fail-open", () => {
    const r = evaluatePreSend({
      ...CLEAN,
      optedOut: true,
      repurchasedSinceApproval: true,
      failOpen: true,
    });
    assert.equal(r.send, false);
    if (!r.send) assert.equal(r.code, "opt_out");
  });

  it("prioridad: skip terminal manda sobre hold", () => {
    const r = evaluatePreSend({
      ...CLEAN,
      repurchasedSinceApproval: true,
      failOpen: true,
      predictionSendable: false,
    });
    assert.equal(r.send, false);
    if (!r.send) {
      assert.equal(r.terminal, true);
      assert.equal(r.code, "repurchased");
    }
  });
});
