// Comisión agencia: empresa default + override IO, % sobre bruto, neto a agencia.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAgencyDeal,
  normalizeCommissionPct,
  resolveCommissionPct,
  splitAgencyAmounts,
} from "@/lib/agency-commission";

describe("agency commission", () => {
  it("override IO gana a default empresa", () => {
    assert.equal(resolveCommissionPct(10, 15), 10);
    assert.equal(resolveCommissionPct(null, 15), 15);
    assert.equal(resolveCommissionPct(null, null), 0);
    assert.equal(normalizeCommissionPct(150), null);
  });

  it("solo enteros 0-100", () => {
    assert.equal(normalizeCommissionPct(15), 15);
    assert.equal(normalizeCommissionPct("15"), 15);
    assert.equal(normalizeCommissionPct(15.5), null);
    assert.equal(normalizeCommissionPct("15.5"), null);
    assert.equal(normalizeCommissionPct("  "), null);
  });
  it("marca directa no es deal de agencia", () => {
    assert.equal(isAgencyDeal("a", "a"), false);
    assert.equal(isAgencyDeal("a", null), false);
    assert.equal(isAgencyDeal("a", "b"), true);
  });

  it("parte bruto en comisión redondeada + neto", () => {
    const s = splitAgencyAmounts(10000, 15);
    assert.equal(s.commissionMinor, 1500);
    assert.equal(s.netMinor, 8500);
  });
});
