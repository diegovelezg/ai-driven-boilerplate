// Cuentas que atiende un contacto de agencia: normalización del set.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeContactAccountSet, normalizeAgencyAttendantsSet, validateContactAccountPair } from "@/lib/contact-accounts";

describe("contact accounts", () => {
  it("rechaza set sin contacto o sin agencia", () => {
    assert.equal(normalizeContactAccountSet({ contactId: "", agencyCompanyId: "ag", advertiserCompanyIds: ["a"] }).ok, false);
    assert.equal(normalizeContactAccountSet({ contactId: "c", agencyCompanyId: "", advertiserCompanyIds: ["a"] }).ok, false);
  });

  it("normaliza: únicos, sin vacíos ni auto-par", () => {
    const res = normalizeContactAccountSet({
      contactId: " c ",
      agencyCompanyId: "ag",
      advertiserCompanyIds: ["a1", " a1 ", "", "ag", "c", "a2"],
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.value, { contactId: "c", agencyCompanyId: "ag", advertiserCompanyIds: ["a1", "a2"] });
    }
  });

  it("set vacío = sin asignación declarada", () => {
    const res = normalizeContactAccountSet({ contactId: "c", agencyCompanyId: "ag", advertiserCompanyIds: [] });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value.advertiserCompanyIds, []);
  });

  it("par suelto rechaza auto-par agencia=anunciante", () => {
    assert.equal(validateContactAccountPair({ contactId: "c", agencyCompanyId: "ag", advertiserCompanyId: "ag" }).ok, false);
    assert.equal(validateContactAccountPair({ contactId: "c", agencyCompanyId: "ag", advertiserCompanyId: "a" }).ok, true);
  });

  it("vista anunciante: normaliza atendidos únicos", () => {
    const res = normalizeAgencyAttendantsSet({
      agencyCompanyId: "ag",
      advertiserCompanyId: "a",
      contactIds: ["c1", " c1 ", "", "c2"],
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, { agencyCompanyId: "ag", advertiserCompanyId: "a", contactIds: ["c1", "c2"] });
  });

  it("vista anunciante: rechaza sin agencia o auto-par", () => {
    assert.equal(normalizeAgencyAttendantsSet({ agencyCompanyId: "", advertiserCompanyId: "a", contactIds: [] }).ok, false);
    assert.equal(normalizeAgencyAttendantsSet({ agencyCompanyId: "x", advertiserCompanyId: "x", contactIds: [] }).ok, false);
  });
});
