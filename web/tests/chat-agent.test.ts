// Chat DOOH en vivo: el agente cablea modelo + 6 tools y el body se valida.
// Corre con: npm test (node:test vía tsx).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { buildChatPrompt, parseChatBody } from "../lib/api/chat-protocol";
import {
  buildScopeBlock,
  createDoohTools,
  getCustomerAgent,
} from "../lib/adk/agents/customer-agent";

describe("parseChatBody (fail-closed)", () => {
  it("acepta historial válido con storeId", () => {
    const { messages, storeId } = parseChatBody({
      storeId: "123",
      messages: [
        { role: "user", content: "hola" },
        { role: "assistant", content: "hola, ¿en qué ayudo?" },
        { role: "user", content: "¿Está libre los próximos 14 días?" },
      ],
    });
    assert.equal(messages.length, 3);
    assert.equal(storeId, "123");
  });
  it("rechaza body sin messages, rol inválido y último turno no-usuario", () => {
    assert.throws(() => parseChatBody(null), /Body inválido/);
    assert.throws(() => parseChatBody({ messages: [] }), /1–50/);
    assert.throws(() => parseChatBody({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] }), /último turno/);
    assert.throws(() => parseChatBody({ messages: [{ role: "bot", content: "x" }] }), /role/);
    assert.throws(() => parseChatBody({ messages: [{ role: "user", content: "  " }] }), /Contenido inválido/);
  });
});

describe("buildChatPrompt (stateless)", () => {
  it("pone la pregunta actual primero y conserva historial", () => {
    const { text } = buildChatPrompt([
      { role: "user", content: "primera" },
      { role: "assistant", content: "respuesta" },
      { role: "user", content: "¿precio?" },
    ]);
    assert.match(text, /Pregunta actual del usuario/);
    assert.match(text, /¿precio\?/);
    assert.match(text, /primera/);
  });
});

describe("dooh_agent cableado (no 501)", () => {
  before(() => {
    process.env.OPENAI_API_KEY ??= "test-key";
    process.env.DEEPSEEK_API_KEY ??= "test-key";
  });
  it("expone 6 tools incluyendo get_screen", () => {
    const tools = createDoohTools({ storeId: "s1" });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "explain_kpi",
      "get_company",
      "get_finance",
      "get_order",
      "get_screen",
      "search_inventory",
    ]);
  });
  it("el agente trae modelo (no solo instrucción + tools)", () => {
    const agent = getCustomerAgent({ storeId: "s1", screenId: "screen-1", focusLabel: "Pantalla X" });
    const cfg = agent as unknown as Record<string, unknown>;
    assert.ok(cfg.model, "LlmAgent sin model: el chat no puede responder");
    assert.equal(cfg.name, "dooh_agent");
  });
  it("la instrucción inyecta foco y fecha Lima", () => {
    const block = buildScopeBlock({ storeId: "s1", screenId: "screen-1", focusLabel: "28 de Julio" });
    assert.match(block, /pantalla enfocada: screen-1/);
    assert.match(block, /hoy=\d{4}-\d{2}-\d{2}/);
    assert.match(block, /periodo por defecto=/);
  });
});
