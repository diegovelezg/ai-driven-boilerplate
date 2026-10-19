// Ejes de segmentación (issue #14A): tiers de decil de valor.
// Corre con: npm test (node:test stdlib via tsx). Solo lógica pura.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BANDA_VALUES,
  DECIL_VALUES,
  ELEGIBILIDAD_VALUES,
  VENTANA_VALUES,
  matchesDecilFilter,
} from "@/lib/customer-predictions";

describe("ejes de segmentación", () => {
  it("decil: tiers alto/medio/bajo", () => {
    assert.equal(matchesDecilFilter(10, "alto"), true);
    assert.equal(matchesDecilFilter(8, "alto"), true);
    assert.equal(matchesDecilFilter(7, "alto"), false);
    assert.equal(matchesDecilFilter(7, "medio"), true);
    assert.equal(matchesDecilFilter(4, "medio"), true);
    assert.equal(matchesDecilFilter(3, "medio"), false);
    assert.equal(matchesDecilFilter(3, "bajo"), true);
    assert.equal(matchesDecilFilter(1, "bajo"), true);
    assert.equal(matchesDecilFilter(4, "bajo"), false);
  });

  it("decil null nunca calza", () => {
    assert.equal(matchesDecilFilter(null, "alto"), false);
    assert.equal(matchesDecilFilter(null, "medio"), false);
    assert.equal(matchesDecilFilter(null, "bajo"), false);
  });

  it("sets de ejes con los valores de la migración", () => {
    for (const v of ["antes", "en", "pasada", "dormido"]) assert.ok(VENTANA_VALUES.has(v), v);
    for (const v of ["organico-probable", "recuperable", "lejos"]) assert.ok(BANDA_VALUES.has(v), v);
    for (const v of ["ok", "sin-canal", "contacto-reciente"]) assert.ok(ELEGIBILIDAD_VALUES.has(v), v);
    for (const v of ["alto", "medio", "bajo"]) assert.ok(DECIL_VALUES.has(v), v);
  });
});
