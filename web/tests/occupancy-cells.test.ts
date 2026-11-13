// Estados de celda día-pantalla (matriz de ocupación).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dayCellState } from "@/lib/occupancy-cells";

describe("dayCellState", () => {
  it("0 o negativo es libre", () => {
    assert.equal(dayCellState(0, 10), "free");
    assert.equal(dayCellState(-1, 10), "free");
  });
  it("1–79% es bajo", () => {
    assert.equal(dayCellState(1, 10), "low");
    assert.equal(dayCellState(7, 10), "low");
  });
  it("80–99% es alto", () => {
    assert.equal(dayCellState(8, 10), "high");
    assert.equal(dayCellState(9, 10), "high");
  });
  it("100% es lleno, más es sobreventa", () => {
    assert.equal(dayCellState(10, 10), "full");
    assert.equal(dayCellState(11, 10), "over");
  });
  it("sin capacidad válida, ocupado es lleno", () => {
    assert.equal(dayCellState(3, 0), "full");
    assert.equal(dayCellState(0, 0), "free");
  });
});
