// Duplicados de contactos: normalización y agrupado (puros, sin DB).
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findContactDuplicateGroups,
  normalizeContactEmail,
  normalizeContactPhone,
  type DuplicateContactRow,
} from "../lib/contact-duplicates";

const row = (over: Partial<DuplicateContactRow> & { id: string }): DuplicateContactRow => ({
  company_id: null,
  company_name: null,
  first_name: "A",
  last_name: "B",
  email: null,
  phone: null,
  job_title: null,
  is_primary: false,
  ...over,
});

describe("normalización", () => {
  it("email case-insensitive con trim", () => {
    assert.equal(normalizeContactEmail("  Ana@EMP.com "), "ana@emp.com");
    assert.equal(normalizeContactEmail(""), null);
    assert.equal(normalizeContactEmail(null), null);
  });

  it("teléfono solo dígitos, +51 opcional", () => {
    assert.equal(normalizeContactPhone("+51 999 888 777"), "999888777");
    assert.equal(normalizeContactPhone("999888777"), "999888777");
    assert.equal(normalizeContactPhone("(01) 234-5678"), "012345678");
    assert.equal(normalizeContactPhone(null), null);
  });
});

describe("agrupado", () => {
  it("mismo email agrupa aunque el teléfono difiera", () => {
    const groups = findContactDuplicateGroups([
      row({ id: "a", email: "a@x.com", phone: "111" }),
      row({ id: "b", email: "A@X.com", phone: "222" }),
      row({ id: "c", email: "c@x.com", phone: "333" }),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].ids, ["a", "b"]);
    assert.deepEqual(groups[0].reasons, ["email"]);
  });

  it("union transitiva: email con uno, teléfono con otro", () => {
    const groups = findContactDuplicateGroups([
      row({ id: "a", email: "a@x.com", phone: "111" }),
      row({ id: "b", email: "a@x.com", phone: "222" }),
      row({ id: "c", email: "c@x.com", phone: "222" }),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].ids, ["a", "b", "c"]);
    assert.deepEqual(groups[0].reasons, ["email", "phone"]);
  });

  it("sin canal no agrupa", () => {
    const groups = findContactDuplicateGroups([row({ id: "a" }), row({ id: "b" })]);
    assert.equal(groups.length, 0);
  });

  it("orden determinista", () => {
    const mk = () => [
      row({ id: "b", email: "d@x.com" }),
      row({ id: "a", email: "D@X.COM" }),
    ];
    assert.deepEqual(
      findContactDuplicateGroups(mk()).map((g) => g.ids),
      findContactDuplicateGroups(mk()).map((g) => g.ids),
    );
  });
});
