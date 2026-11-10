// Comisión agencia: empresa default + override IO, % sobre bruto, neto a agencia.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveOrderCommissionPct,
  isAgencyDeal,
  normalizeCommissionPct,
  resolveCommissionAgencyPct,
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

  it("intermediaria vinculada gana al billing agencia", () => {
    assert.equal(resolveCommissionAgencyPct(15, "agencia", 10), 15);
    assert.equal(resolveCommissionAgencyPct(null, "agencia", 10), 10);
    assert.equal(resolveCommissionAgencyPct(null, "anunciante", 10), null);
    assert.equal(resolveCommissionAgencyPct(null, null, null), null);
  });

  it("% efectivo: override > intermediaria > billing agencia > 0", () => {
    const base = { agencyCompanyPct: 15, billingKind: "anunciante", billingCompanyPct: null };
    assert.equal(effectiveOrderCommissionPct({ ...base, ioOverride: 10 }), 10);
    assert.equal(effectiveOrderCommissionPct({ ...base, ioOverride: null }), 15);
    // Caso agencia cliente sin intermediaria: hereda del billing.
    assert.equal(
      effectiveOrderCommissionPct({ ioOverride: null, agencyCompanyPct: null, billingKind: "agencia", billingCompanyPct: 20 }),
      20,
    );
    // Directo sin agencia: 0.
    assert.equal(
      effectiveOrderCommissionPct({ ioOverride: null, agencyCompanyPct: null, billingKind: "anunciante", billingCompanyPct: null }),
      0,
    );
  });
});
