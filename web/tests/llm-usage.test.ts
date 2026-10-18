// Metering LLM por tenant (issue #15): parseo de `usage` por proveedor.
// Corre con: npm test (node:test stdlib via tsx). Solo logica pura.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChatUsage } from "@/lib/ai/usage";

describe("parseChatUsage", () => {
  it("OpenAI: prompt/completion/total + reasoning", () => {
    const u = parseChatUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    });
    assert.deepEqual(u, { promptTokens: 100, completionTokens: 50, totalTokens: 150, reasoningTokens: 20 });
  });

  it("DeepSeek: misma forma OpenAI sin details", () => {
    const u = parseChatUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    assert.deepEqual(u, { promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: null });
  });

  it("total ausente se deriva como suma", () => {
    const u = parseChatUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } });
    assert.equal(u?.totalTokens, 10);
  });

  it("Anthropic: input/output_tokens", () => {
    const u = parseChatUsage({ usage: { input_tokens: 200, output_tokens: 80 } });
    assert.deepEqual(u, { promptTokens: 200, completionTokens: 80, totalTokens: 280, reasoningTokens: null });
  });

  it("Gemini: usageMetadata", () => {
    const u = parseChatUsage({
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12, totalTokenCount: 42 },
    });
    assert.deepEqual(u, { promptTokens: 30, completionTokens: 12, totalTokens: 42, reasoningTokens: null });
  });

  it("chunk final SSE con solo usage (sin choices)", () => {
    const u = parseChatUsage({ usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    assert.equal(u?.totalTokens, 10);
  });

  it("vacio o ceros -> null", () => {
    assert.equal(parseChatUsage(null), null);
    assert.equal(parseChatUsage({}), null);
    assert.equal(parseChatUsage({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), null);
  });
});
