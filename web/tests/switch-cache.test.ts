// Switch email ↔ whatsapp con caché: sin regenerar si hay variante fresca.
// Corre con: npm test (node:test vía tsx, sin BD ni LLM).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getChannelVariants,
  isReusableChannelVariant,
  type ChannelVariant,
} from "@/lib/channel-variants";
import { COPYWRITER_GEN } from "@/lib/copywriter-gen";

const fresh = (over: Partial<ChannelVariant> = {}): ChannelVariant => ({
  subject: "Vuelve",
  body: "Hola, te esperamos".repeat(10).slice(0, 200),
  generator: COPYWRITER_GEN,
  at: new Date().toISOString(),
  ...over,
});

describe("switch con caché de variantes", () => {
  it("reutiliza variante fresca del otro canal", () => {
    assert.equal(isReusableChannelVariant("email", fresh()), true);
    assert.equal(
      isReusableChannelVariant("whatsapp", fresh({ subject: null, body: "hola" })),
      true,
    );
  });

  it("no reutiliza stale, vacía ni fuera de topes", () => {
    assert.equal(isReusableChannelVariant("email", fresh({ generator: "copywriter:v1" })), false);
    assert.equal(isReusableChannelVariant("email", fresh({ body: "  " })), false);
    assert.equal(isReusableChannelVariant("email", fresh({ subject: null })), false);
    assert.equal(isReusableChannelVariant("email", fresh({ body: "x".repeat(801) })), false);
    assert.equal(isReusableChannelVariant("whatsapp", fresh({ body: "x".repeat(451) })), false);
    assert.equal(isReusableChannelVariant("email", null), false);
    assert.equal(isReusableChannelVariant("email", undefined), false);
  });

  it("getChannelVariants tolera evidencias viejas", () => {
    assert.deepEqual(getChannelVariants(null), {});
    assert.deepEqual(getChannelVariants({}), {});
    assert.deepEqual(getChannelVariants({ variants: [] }), {});
    const v = fresh();
    assert.deepEqual(getChannelVariants({ variants: { email: v } }), { email: v });
  });
});
