// Picker de empresas: filtro fuzzy en memoria (modo cliente).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterPickCompanies } from "@/lib/company-pick";

const COMPANIES = [
  { id: "1", name: "Publicis Groupe Media", tax_id: "20476465614", domain: "starcomww.com", city: "Lima" },
  { id: "2", name: "Hipermercados Tottus", tax_id: "20508565934", domain: "tottus.com.pe", city: "Lima" },
  { id: "3", name: "Media Dialogue", tax_id: "20609099888", domain: "targooh.com", city: "Lima" },
];

describe("company pick", () => {
  it("sin query devuelve todo en orden", () => {
    assert.deepEqual(filterPickCompanies(COMPANIES, ""), COMPANIES);
    assert.deepEqual(filterPickCompanies(COMPANIES, "  "), COMPANIES);
  });

  it("filtra por nombre, fiscal, web o ciudad (AND de tokens)", () => {
    assert.deepEqual(filterPickCompanies(COMPANIES, "tottus").map((c) => c.id), ["2"]);
    assert.deepEqual(filterPickCompanies(COMPANIES, "20476465614").map((c) => c.id), ["1"]);
    assert.deepEqual(filterPickCompanies(COMPANIES, "targooh").map((c) => c.id), ["3"]);
    assert.deepEqual(filterPickCompanies(COMPANIES, "media lima").map((c) => c.id), ["1", "3"]);
  });

  it("sin calce devuelve vacío", () => {
    assert.deepEqual(filterPickCompanies(COMPANIES, "inexistente zzz"), []);
  });
});
