// Validación cliente del form de empresas: espejo liviano de normalizeCompany.
// Corre con: npm test (node:test vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fieldsFromMessage, validateCompanyFields } from "@/app/(dashboard)/companies/company-validation";

describe("validateCompanyFields clasificaciones", () => {
  it("exige categoría del anunciante", () => {
    const errs = validateCompanyFields({ name: "Acme", domain: "", country: "PE", kind: "anunciante", categoryIab: "" });
    assert.deepEqual(errs.map((e) => e.key), ["category"]);
    assert.equal(
      validateCompanyFields({ name: "Acme", domain: "", country: "PE", kind: "anunciante", categoryIab: "IAB8" }).length,
      0,
    );
    assert.equal(
      validateCompanyFields({ name: "Agencia X", domain: "", country: "PE", kind: "agencia", categoryIab: "" }).length,
      0,
    );
  });

  it("exige tipo de proveedor solo cuando kind = proveedor", () => {
    const errs = validateCompanyFields({ name: "Andamios", domain: "", country: "PE", kind: "proveedor", providerType: "" });
    assert.deepEqual(errs.map((e) => e.key), ["providerType"]);
    assert.equal(
      validateCompanyFields({ name: "Andamios", domain: "", country: "PE", kind: "proveedor", providerType: "installation" }).length,
      0,
    );
    assert.equal(
      validateCompanyFields({ name: "Acme", domain: "", country: "PE", kind: "anunciante", categoryIab: "IAB8", providerType: "" }).length,
      0,
    );
  });
});

describe("fieldsFromMessage clasificaciones", () => {
  it("mapea errores de categoría y proveedor a su campo", () => {
    assert.deepEqual(fieldsFromMessage("Categoría IAB inválida (IAB1–IAB24)."), ["category"]);
    assert.deepEqual(fieldsFromMessage("Categoría requerida para anunciantes."), ["category"]);
    assert.deepEqual(fieldsFromMessage("Tipo de proveedor inválido."), ["providerType"]);
    assert.deepEqual(fieldsFromMessage("Tipo de proveedor solo aplica a proveedores."), ["providerType"]);
    assert.deepEqual(fieldsFromMessage("Tipo requerido: agencia, anunciante o proveedor."), ["kind"]);
  });
});
