import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitIgv } from "@/lib/format";
import { splitTax, taxNameForCountry, vatRateForCountry } from "@/lib/tax-rate";

describe("IVA por país del tenant", () => {
  it("tasas por shop_country", () => {
    assert.equal(vatRateForCountry("PE"), 0.18);
    assert.equal(vatRateForCountry("cl"), 0.19);
    assert.equal(vatRateForCountry("MX"), 0.16);
    assert.equal(vatRateForCountry("CO"), 0.19);
    assert.equal(vatRateForCountry("XX"), 0.18);
    assert.equal(vatRateForCountry(null), 0.18);
  });

  it("nombres locales del impuesto", () => {
    assert.equal(taxNameForCountry("PE"), "IGV");
    assert.equal(taxNameForCountry("MX"), "IVA");
    assert.equal(taxNameForCountry("DO"), "ITBIS");
    assert.equal(taxNameForCountry("PA"), "ITBMS");
    assert.equal(taxNameForCountry(null), "IGV");
  });

  it("splitTax usa la tasa del tenant", () => {
    assert.deepEqual(splitTax(500000, "PE"), { net: 500000, tax: 90000, total: 590000, rate: 0.18, name: "IGV" });
    const mx = splitTax(500000, "MX");
    assert.equal(mx.tax, 80000);
    assert.equal(mx.total, 580000);
    assert.equal(mx.name, "IVA");
  });

  it("splitIgv legacy default PE + acepta país tenant", () => {
    assert.deepEqual(splitIgv(500000), { net: 500000, igv: 90000, total: 590000 });
    assert.deepEqual(splitIgv(500000, "MX"), { net: 500000, igv: 80000, total: 580000 });
  });
});
