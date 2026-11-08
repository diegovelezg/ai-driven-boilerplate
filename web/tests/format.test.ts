import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDecimal, formatDayMonth, formatMoney, formatNumber, formatPercent, formatPercentPoints, formatTimeAgo, toTitleCase } from "@/lib/format";

describe("formato numérico único (es: miles '.' y decimales ',')", () => {
  it("formatNumber agrupa miles con punto y 0 decimales por defecto", () => {
    assert.equal(formatNumber(1234567), "1.234.567");
    assert.equal(formatNumber(1234.56), "1.235");
    assert.equal(formatNumber(-9876.5), "-9.877");
    assert.equal(formatNumber(999), "999");
    assert.equal(formatNumber(null), "—");
    assert.equal(formatNumber(Number.NaN), "—");
    assert.equal(formatNumber(Number.POSITIVE_INFINITY), "—");
    assert.equal(formatNumber("1234567"), "1.234.567");
  });

  it("formatDecimal usa coma decimal y respeta los decimales pedidos", () => {
    assert.equal(formatDecimal(1234.56, 2), "1.234,56");
    assert.equal(formatDecimal(12.3, 1), "12,3");
    assert.equal(formatDecimal(12.34), "12");
    assert.equal(formatDecimal(null, 2), "—");
  });

  it("porcentajes usan el mismo separador", () => {
    assert.equal(formatPercent(0.876), "88%");
    assert.equal(formatPercent(0.876, 1), "87,6%");
    assert.equal(formatPercentPoints(1234.5), "1.235%");
  });

  it("formatPercent nunca devuelve '—%' con no-finitos", () => {
    assert.equal(formatPercent(null), "—");
    assert.equal(formatPercent(undefined), "—");
    assert.equal(formatPercent(Number.NaN), "—");
    assert.equal(formatPercent(Number.POSITIVE_INFINITY), "—");
    assert.equal(formatPercentPoints(null), "—");
    assert.equal(formatPercentPoints(Number.NaN), "—");
  });

  it("formatMoney conserva el símbolo y aplica el formato único", () => {
    assert.equal(formatMoney(36461777, "PEN"), "S/ 364.618");
    assert.equal(formatMoney(123456, "USD"), "US$ 1.235");
    assert.equal(formatMoney(123456, null), "S/ 1.235");
  });

  it("formatMoney soporta céntimos explícitos sin doble redondeo", () => {
    assert.equal(formatMoney(1999, "PEN", 2), "S/ 19,99");
    assert.equal(formatMoney(1999, "PEN"), "S/ 20");
    assert.equal(formatMoney(100, "PEN", 2), "S/ 1,00");
  });

  it("formatMoney degrada a '—' con monto inválido y normaliza moneda vacía", () => {
    assert.equal(formatMoney(null, "PEN"), "—");
    assert.equal(formatMoney(Number.NaN, "PEN"), "—");
    assert.equal(formatMoney(undefined, "PEN"), "—");
    assert.equal(formatMoney(123456, ""), "S/ 1.235");
    assert.equal(formatMoney(123456, "  pen  "), "S/ 1.235");
    assert.equal(formatMoney(123456, "XYZ"), "XYZ 1.235");
  });
});

describe("toTitleCase", () => {
  it("razones sociales en Title Case con siglas intactas", () => {
    assert.equal(toTitleCase("ESPECIALIDADES DIGITALES INTERNACIONALES S.A.C"), "Especialidades Digitales Internacionales S.A.C");
    assert.equal(toTitleCase("Hipermercados Tottus S.A."), "Hipermercados Tottus S.A.");
    assert.equal(toTitleCase("STRONG MINDS PERU SAC"), "Strong Minds Peru SAC");
    assert.equal(toTitleCase("MEDIA DIALOGUE S.A.C."), "Media Dialogue S.A.C.");
    assert.equal(toTitleCase("PACIFICO COMPAÑIA DE SEGUROS Y REASEGUROS"), "Pacifico Compañia de Seguros y Reaseguros");
    assert.equal(toTitleCase("  Toyota  "), "Toyota");
    assert.equal(toTitleCase(null), "—");
    assert.equal(toTitleCase(""), "—");
  });
});

describe("formatTimeAgo", () => {
  it("relativo corto en español para feeds", () => {
    const now = Date.parse("2026-11-08T12:00:00Z");
    assert.equal(formatTimeAgo(new Date(now - 30_000).toISOString(), now), "ahora mismo");
    assert.equal(formatTimeAgo(new Date(now - 5 * 60_000).toISOString(), now), "hace 5 min");
    assert.equal(formatTimeAgo(new Date(now - 3 * 3_600_000).toISOString(), now), "hace 3 h");
    assert.equal(formatTimeAgo(new Date(now - 2 * 86_400_000).toISOString(), now), "hace 2 d");
    assert.equal(formatTimeAgo(null, now), "—");
    assert.equal(formatTimeAgo("no-fecha", now), "—");
  });

  it("formatDayMonth para vigencias", () => {
    assert.equal(formatDayMonth("2026-11-08"), "08/11");
    assert.equal(formatDayMonth("2026-11-08T00:00:00-05:00"), "08/11");
    assert.equal(formatDayMonth(null), "—");
    assert.equal(formatDayMonth("no-fecha"), "—");
  });
});
