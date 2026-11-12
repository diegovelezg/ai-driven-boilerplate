import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  minorToAmountInput,
  parseWholeAmountToMinor,
  suggestedInvoiceAmount,
} from "../app/(dashboard)/orders/invoice-validation";

describe("suggestedInvoiceAmount (default Registrar factura)", () => {
  it("sin facturas: bruto + IGV (PE 18%)", () => {
    const s = suggestedInvoiceAmount(500000, 0, "PE");
    assert.equal(s.suggestedMinor, 590000);
    assert.equal(s.netMinor, 500000);
    assert.equal(s.taxMinor, 90000);
    assert.equal(s.taxName, "IGV");
  });
  it("con facturas: remanente neto + IGV", () => {
    // Bruto 5000, ya facturado 2000 → remanente 3000 + 540 = 3540.
    const s = suggestedInvoiceAmount(500000, 200000, "PE");
    assert.equal(s.suggestedMinor, 354000);
    assert.equal(s.netMinor, 300000);
    assert.equal(s.taxMinor, 54000);
  });
  it("tasa según país (MX 16% → IVA)", () => {
    const s = suggestedInvoiceAmount(500000, 0, "MX");
    assert.equal(s.suggestedMinor, 580000);
    assert.equal(s.taxName, "IVA");
  });
  it("sin remanente: null (orden ya facturada)", () => {
    assert.equal(suggestedInvoiceAmount(500000, 500000, "PE").suggestedMinor, null);
    assert.equal(suggestedInvoiceAmount(500000, 600000, "PE").suggestedMinor, null);
  });
  it("bruto cero: null", () => {
    assert.equal(suggestedInvoiceAmount(0, 0, "PE").suggestedMinor, null);
  });
});

describe("parseWholeAmountToMinor (facturas sin decimales)", () => {
  it("entero con miles → céntimos", () => {
    assert.equal(parseWholeAmountToMinor("5,900"), 590000);
    assert.equal(parseWholeAmountToMinor("5000"), 500000);
  });
  it("rechaza decimales, cero y negativo", () => {
    assert.equal(parseWholeAmountToMinor("5,900.50"), null);
    assert.equal(parseWholeAmountToMinor("5,900.00"), null);
    assert.equal(parseWholeAmountToMinor("0"), null);
    assert.equal(parseWholeAmountToMinor("-10"), null);
    assert.equal(parseWholeAmountToMinor("abc"), null);
  });
  it("rechaza miles mal formados", () => {
    assert.equal(parseWholeAmountToMinor("5,00,0"), null);
    assert.equal(parseWholeAmountToMinor(",5000"), null);
  });
});

describe("minorToAmountInput (round-trip con parseWholeAmountToMinor)", () => {
  it("590000 → 5,900 → 590000", () => {
    const str = minorToAmountInput(590000);
    assert.equal(str, "5,900");
    assert.equal(parseWholeAmountToMinor(str), 590000);
  });
  it("redondea al entero más cercano", () => {
    assert.equal(minorToAmountInput(354050), "3,541");
    assert.equal(minorToAmountInput(354049), "3,540");
  });
});
