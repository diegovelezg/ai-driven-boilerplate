// Issue #16 Fase 1 (re-review): cierre garantizado del run single (P0),
// veto con TTL (P1) y helper único de detección de veto (P1).
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifySingleFinish,
  isJudgeVetoMessage,
  JUDGE_VETO_PREFIX,
  runSingleWithAudit,
  singleSignalScope,
  type SingleFinish,
} from "@/lib/single-audit";
import { isCompatible } from "@/lib/operations";
import { CONTACTABILITY_VETO_TTL_MS, parseContactability } from "@/lib/mira";

const VETO = `${JUDGE_VETO_PREFIX}: las ferias ya vencieron`;
const NOW = Date.UTC(2026, 9, 19);

describe("isJudgeVetoMessage", () => {
  it("detecta el veto con motivo", () => {
    assert.equal(isJudgeVetoMessage(VETO), true);
  });

  it("no confunde otros fallos con veto", () => {
    assert.equal(isJudgeVetoMessage("Ya tiene un borrador en Review."), false);
    assert.equal(isJudgeVetoMessage("No se pudo redactar."), false);
    assert.equal(isJudgeVetoMessage(""), false);
  });
});

describe("runSingleWithAudit (P0: sin running eterno)", () => {
  it("draft que lanza → cierra en error y devuelve el mensaje", async () => {
    const finishes: SingleFinish[] = [];
    const r = await runSingleWithAudit({
      start: async () => "run-1",
      advance: async () => {},
      finish: async (_id, f) => {
        finishes.push(f);
      },
      draft: async () => {
        throw new Error("boom en getRankedMira");
      },
    });
    assert.deepEqual(r, { ok: false, message: "boom en getRankedMira" });
    assert.equal(finishes.length, 1);
    assert.deepEqual(finishes[0], {
      status: "error",
      processed: 0,
      failed: 1,
      summary: null,
      error: "boom en getRankedMira",
      pulseState: null,
      errorCode: null,
    });
  });

  it("veto → done/paused sin failed (omisión, no fallo)", async () => {
    const finishes: SingleFinish[] = [];
    const r = await runSingleWithAudit({
      start: async () => "run-2",
      advance: async () => {},
      finish: async (_id, f) => {
        finishes.push(f);
      },
      draft: async () => ({ ok: false, message: VETO }),
    });
    assert.equal(r.ok, false);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].status, "done");
    assert.equal(finishes[0].failed, 0);
    assert.equal(finishes[0].summary, VETO);
    assert.equal(finishes[0].pulseState, "paused");
    assert.equal(finishes[0].errorCode, "judge_veto");
  });

  it("éxito → done/needs con processed 1", async () => {
    const finishes: SingleFinish[] = [];
    const r = await runSingleWithAudit({
      start: async () => "run-3",
      advance: async () => {},
      finish: async (_id, f) => {
        finishes.push(f);
      },
      draft: async () => ({ ok: true, message: "Borrador (whatsapp) listo en Review." }),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(finishes[0], {
      status: "done",
      processed: 1,
      failed: 0,
      summary: "Borrador (whatsapp) listo en Review.",
      error: null,
      pulseState: "needs",
      errorCode: null,
    });
  });

  it("sin run (start null) → el draft corre igual, sin finish", async () => {
    let finished = 0;
    const r = await runSingleWithAudit({
      start: async () => null,
      advance: async () => {
        throw new Error("no debería llamarse");
      },
      finish: async () => {
        finished += 1;
      },
      draft: async () => ({ ok: true, message: "ok" }),
    });
    assert.equal(r.ok, true);
    assert.equal(finished, 0);
  });

  it("fallo de finish no rompe el resultado", async () => {
    const r = await runSingleWithAudit({
      start: async () => "run-4",
      advance: async () => {},
      finish: async () => {
        throw new Error("RLS");
      },
      draft: async () => ({ ok: true, message: "ok" }),
    });
    assert.deepEqual(r, { ok: true, message: "ok" });
  });
});

describe("classifySingleFinish", () => {  it("fallo común → error con failed 1", () => {
    assert.deepEqual(classifySingleFinish({ ok: false, message: "LLM 500" }), {
      status: "error",
      processed: 0,
      failed: 1,
      summary: null,
      error: "LLM 500",
      pulseState: null,
      errorCode: null,
    });
  });
});

describe("parseContactability TTL (P1: veto con recuperación)", () => {
  it("veto fresco → se mantiene (botón muerto con motivo)", () => {
    const at = new Date(NOW - 60_000).toISOString();
    assert.deepEqual(
      parseContactability({ contactability: { eligible: false, reason: "vencido", at } }, NOW),
      { eligible: false, reason: "vencido", at },
    );
  });

  it("veto con at viejo (>TTL) → null, vuelve a ofrecer Redactar", () => {
    const at = new Date(NOW - CONTACTABILITY_VETO_TTL_MS - 1_000).toISOString();
    assert.equal(
      parseContactability({ contactability: { eligible: false, reason: "vencido", at } }, NOW),
      null,
    );
  });

  it("veredicto favorable intacto + casos sin veredicto", () => {
    const at = new Date(NOW - 60_000).toISOString();
    assert.deepEqual(
      parseContactability({ contactability: { eligible: true, reason: "vigente", at } }, NOW),
      { eligible: true, reason: "vigente", at },
    );
    assert.equal(parseContactability(null, NOW), null);
    assert.equal(parseContactability({}, NOW), null);
  });
});

describe("singleSignalScope (P1: el run persistido lleva scope)", () => {
  it("acota a la señal", () => {
    assert.deepEqual(singleSignalScope("sig-1"), { scopeKind: "signal", scopeId: "sig-1" });
  });

  it("cierra el loop: segundo single sobre la misma señal conflicta", () => {
    // El wiring persiste el run con este scope; el pre-check del segundo
    // intento lo evalúa con la matriz. Si divergen, este test cae.
    const stored = { kind: "copywriter_single", ...singleSignalScope("sig-1"), label: "Redacción individual" };
    assert.equal(
      isCompatible({ kind: "copywriter_single", ...singleSignalScope("sig-1") }, [stored]),
      false,
    );
    assert.equal(
      isCompatible({ kind: "copywriter_single", ...singleSignalScope("sig-2") }, [stored]),
      true,
    );
  });
});
