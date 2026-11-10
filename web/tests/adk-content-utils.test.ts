// Cobertura de los helpers compartidos de los adaptadores ADK
// (`lib/adk/models/content-utils.ts`): extracción pura + gate de medición
// (sin DB: los caminos con storeId real los cubre `llm-usage.test.ts`).
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractSystemPrompt,
  extractToolDeclaration,
  meterLlmUsage,
} from "../lib/adk/models/content-utils";

describe("extractSystemPrompt", () => {
  it("string pasa directo", () => {
    assert.equal(extractSystemPrompt({ systemInstruction: "hola" }), "hola");
  });
  it("Content con parts se une con saltos", () => {
    const si = { parts: [{ text: "a" }, { text: "b" }] };
    assert.equal(extractSystemPrompt({ systemInstruction: si }), "a\nb");
  });
  it("Part[] se une con saltos", () => {
    assert.equal(extractSystemPrompt({ systemInstruction: [{ text: "x" }, {}] }), "x\n");
  });
  it("ausente o irreconocible → undefined", () => {
    assert.equal(extractSystemPrompt({}), undefined);
    assert.equal(extractSystemPrompt(), undefined);
    assert.equal(extractSystemPrompt({ systemInstruction: 42 }), undefined);
  });
});

describe("extractToolDeclaration", () => {
  it("usa _getDeclaration cuando existe", () => {
    const tool = { _getDeclaration: () => ({ name: "buscar", description: "d", parameters: { type: "object" } }) };
    assert.deepEqual(extractToolDeclaration(tool), { name: "buscar", description: "d", parameters: { type: "object" } });
  });
  it("falla al nombre/descripción planos si _getDeclaration lanza o falta", () => {
    const throwing = {
      _getDeclaration: () => { throw new Error("no"); },
      name: "plano",
      description: "p",
    };
    assert.deepEqual(extractToolDeclaration(throwing), { name: "plano", description: "p" });
    assert.deepEqual(extractToolDeclaration({ name: "solo-nombre" }), { name: "solo-nombre", description: undefined });
  });
  it("sin nombre → undefined (el caller salta la tool)", () => {
    assert.equal(extractToolDeclaration({}), undefined);
    assert.equal(extractToolDeclaration({ description: "sin nombre" }), undefined);
  });
});

describe("meterLlmUsage", () => {
  const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: null };
  it("sin storeId → no-op (no toca DB)", () => {
    assert.equal(meterLlmUsage({}, usage, { provider: "p", model: "m", t0: Date.now() }), undefined);
    assert.equal(meterLlmUsage({ storeId: 123 }, usage, { provider: "p", model: "m", t0: Date.now() }), undefined);
  });
  it("sin usage → no-op", () => {
    assert.equal(meterLlmUsage({ storeId: "s" }, null, { provider: "p", model: "m", t0: Date.now() }), undefined);
  });
});
