import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRunError } from "@/lib/background";

describe("formatRunError (background_runs.error con stack)", () => {
  it("no-Error pasa tal cual", () => {
    assert.equal(formatRunError("boom"), "boom");
    assert.equal(formatRunError(null), "null");
  });

  it("Error sin stack pasa el mensaje", () => {
    const e = new Error("solo mensaje");
    e.stack = undefined;
    assert.equal(formatRunError(e), "solo mensaje");
  });

  it("Error con stack agrega frames y respeta el cap", () => {
    const e = new Error("fallo");
    const out = formatRunError(e);
    assert.ok(out.startsWith("fallo [at "), `sin frames: ${out.slice(0, 80)}`);
    assert.ok(out.length <= 601, `muy largo: ${out.length}`);
    const tiny = formatRunError(e, 20);
    assert.ok(tiny.length <= 21 && tiny.endsWith("…"), tiny);
  });
});
