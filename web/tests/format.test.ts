import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDecimal, formatMoney, formatNumber, formatPercent, formatPercentPoints } from "@/lib/format";

describe("formato numérico único (es: miles '.' y decimales ',')", () => {
  it("formatNumber agrupa miles con punto y 0 decimales por defecto", () => {
    assert.equal(formatNumber(1234567), "1.234.567");
    assert.equal(formatNumber(1234.56), "1.235");
    assert.equal(formatNumber(-9876.5), "-9.877");
    assert.equal(formatNumber(999), "999");
    assert.equal(formatNumber(null), "—");
    assert.equal(formatNumber(Number.NaN), "—");
  });

  it("formatDecimal usa coma decimal y respeta los decimales pedidos", () => {
    assert.equal(formatDecimal(1234.56, 2), "1.234,56");
    assert.equal(formatDecimal(12.3, 1), "12,3");
    assert.equal(formatDecimal(12.34), "12");
  });

  it("porcentajes usan el mismo separador", () => {
    assert.equal(formatPercent(0.876), "88%");
    assert.equal(formatPercent(0.876, 1), "87,6%");
    assert.equal(formatPercentPoints(1234.5), "1.235%");
  });

  it("formatMoney conserva el símbolo y aplica el formato único", () => {
    assert.equal(formatMoney(36461777, "PEN"), "S/ 364.618");
    assert.equal(formatMoney(123456, "USD"), "US$ 1.235");
    assert.equal(formatMoney(123456, null), "S/ 1.235");
  });
});
