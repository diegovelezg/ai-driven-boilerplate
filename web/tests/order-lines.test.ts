// Validador de líneas de orden (forma + cruces entre líneas nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findLineOverlaps, totalToMinor, validateOrderLines } from "@/lib/order-lines";

const OK = { screen_id: "s1", starts: "2026-11-03", ends: "2026-11-23", total: "2000", notes: null };

describe("order lines", () => {
  it("acepta líneas válidas y exige al menos una", () => {
    assert.deepEqual(validateOrderLines([OK]), []);
    assert.equal(validateOrderLines([])[0]?.message, "Agrega al menos una pantalla.");
  });

  it("detecta pantalla, periodo y total inválidos", () => {
    const problems = validateOrderLines([
      { screen_id: "", starts: "2026-11-03", ends: "2026-11-23", total: 10 },
      { screen_id: "s1", starts: "2026-13-01", ends: "2026-11-23", total: 10 },
      { screen_id: "s1", starts: "2026-11-23", ends: "2026-11-03", total: 10 },
      { screen_id: "s1", starts: "2026-11-03", ends: "2026-11-23", total: "0" },
    ]);
    const keys = problems.map((p) => p.key);
    assert.ok(keys.includes("line-0-screen"));
    assert.ok(keys.includes("line-1-starts"));
    assert.ok(keys.includes("line-2-ends"));
    assert.ok(keys.includes("line-3-total"));
  });

  it("detecta cruces entre líneas nuevas de la misma pantalla", () => {
    const overlaps = findLineOverlaps([
      { ...OK, screen_id: "s1", starts: "2026-11-01", ends: "2026-11-10" },
      { ...OK, screen_id: "s1", starts: "2026-11-05", ends: "2026-11-15" },
      { ...OK, screen_id: "s2", starts: "2026-11-05", ends: "2026-11-15" },
    ]);
    assert.deepEqual(overlaps, [[0, 1]]);
    assert.ok(validateOrderLines([
      { ...OK, screen_id: "s1", starts: "2026-11-01", ends: "2026-11-10" },
      { ...OK, screen_id: "s1", starts: "2026-11-05", ends: "2026-11-15" },
    ]).some((p) => p.key === "line-0-overlap"));
  });

  it("total a minor con coma decimal y redondeo", () => {
    assert.equal(totalToMinor("1274"), 127400);
    assert.equal(totalToMinor("898,33"), 89833);
    assert.equal(totalToMinor("0"), null);
    assert.equal(totalToMinor("abc"), null);
  });
});
