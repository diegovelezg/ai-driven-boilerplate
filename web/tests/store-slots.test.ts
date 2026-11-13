import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SLOTS_PER_SCREEN, normalizeSlotsPerScreen } from "../lib/store-slots";

describe("store-slots", () => {
  it("default es 10", () => {
    assert.equal(DEFAULT_SLOTS_PER_SCREEN, 10);
  });
  it("acepta enteros 1..100", () => {
    assert.equal(normalizeSlotsPerScreen(1), 1);
    assert.equal(normalizeSlotsPerScreen(10), 10);
    assert.equal(normalizeSlotsPerScreen(100), 100);
  });
  it("fail-closed al default", () => {
    for (const v of [0, -1, 101, 1.5, NaN, null, undefined, "x", ""]) {
      assert.equal(normalizeSlotsPerScreen(v), 10);
    }
  });
});
