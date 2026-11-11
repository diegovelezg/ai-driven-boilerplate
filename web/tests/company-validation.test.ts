// Validación cliente del form de empresas: espejo liviano de normalizeCompany.
// Corre con: npm test (node:test vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fieldsFromMessage, validateCompanyFields } from "@/app/(dashboard)/companies/company-validation";

describe("validateCompanyFields clasificaciones", () => {
  it("exige razón social además del nombre comercial", () => {
    const errs = validateCompanyFields({ name: "Acme", legalName: "", taxId: "20123456789", domain: "", address: "Av. Arequipa 123", city: "Lima", country: "PE" });
    assert.deepEqual(errs.map((e) => e.key), ["legalName"]);
  });

  it("exige RUC, dirección, ciudad y país", () => {
    const base = { name: "Acme", legalName: "Acme S.A.C.", taxId: "20123456789", domain: "", address: "Av. Arequipa 123", city: "Lima", country: "PE" };
    assert.deepEqual(validateCompanyFields({ ...base, taxId: " " }).map((e) => e.key), ["taxId"]);
    assert.deepEqual(validateCompanyFields({ ...base, address: "" }).map((e) => e.key), ["address"]);
    assert.deepEqual(validateCompanyFields({ ...base, city: "" }).map((e) => e.key), ["city"]);
    assert.deepEqual(validateCompanyFields({ ...base, country: "" }).map((e) => e.key), ["country"]);
    assert.equal(validateCompanyFields(base).length, 0);
  });

  it("exige categoría del anunciante", () => {
    const errs = validateCompanyFields({ name: "Acme", legalName: "Acme S.A.C.", taxId: "20123456789", domain: "", address: "Av. Arequipa 123", city: "Lima", country: "PE", kind: "anunciante", categoryIab: "" });
    assert.deepEqual(errs.map((e) => e.key), ["category"]);
    assert.equal(
      validateCompanyFields({ name: "Acme", legalName: "Acme S.A.C.", taxId: "20123456789", domain: "", address: "Av. Arequipa 123", city: "Lima", country: "PE", kind: "anunciante", categoryIab: "IAB8" }).length,
      0,
    );
    assert.equal(
      validateCompanyFields({ name: "Agencia X", legalName: "Agencia X S.A.C.", taxId: "20123456789", domain: "", address: "Av. Arequipa 123", city: "Lima", country: "PE", kind: "agencia", categoryIab: "" }).length,
      0,
    );
  });

  it("exige tipo de proveedor solo cuando kind = proveedor", () => {
    const errs = validateCompanyFields({ name: "Andamios", legalName: "Andamios S.A.C.", taxId: "20123456789", domain: "", address: "Av. Arequipa 123", city: "Lima", country: "PE", kind: "proveedor", providerType: "" });
    assert.deepEqual(errs.map((e) => e.key), ["providerType"]);
    assert.equal(
      validateCompanyFields({ name: "Andamios", legalName: "Andamios S.A.C.", taxId: "20123456789", domain: "", address: "Av. Arequipa 123", city: "Lima", country: "PE", kind: "proveedor", providerType: "installation" }).length,
      0,
    );
    assert.equal(
      validateCompanyFields({ name: "Acme", legalName: "Acme S.A.C.", taxId: "20123456789", domain: "", address: "Av. Arequipa 123", city: "Lima", country: "PE", kind: "anunciante", categoryIab: "IAB8", providerType: "" }).length,
      0,
    );
  });
});

describe("fieldsFromMessage clasificaciones", () => {
  it("mapea errores de categoría y proveedor a su campo", () => {
    assert.deepEqual(fieldsFromMessage("Razón social requerida (máx 200)."), ["legalName"]);
    assert.deepEqual(fieldsFromMessage("ID fiscal requerido (máx 40)."), ["taxId"]);
    assert.deepEqual(fieldsFromMessage("Dirección requerida (máx 300)."), ["address"]);
    assert.deepEqual(fieldsFromMessage("Ciudad requerida (máx 120)."), ["city"]);
    assert.deepEqual(fieldsFromMessage("País requerido (ISO2, p. ej. PE)."), ["country"]);
    assert.deepEqual(fieldsFromMessage("Categoría IAB inválida (IAB1–IAB24)."), ["category"]);
    assert.deepEqual(fieldsFromMessage("Categoría requerida para anunciantes."), ["category"]);
    assert.deepEqual(fieldsFromMessage("Tipo de proveedor inválido."), ["providerType"]);
    assert.deepEqual(fieldsFromMessage("Tipo de proveedor solo aplica a proveedores."), ["providerType"]);
    assert.deepEqual(fieldsFromMessage("Tipo requerido: agencia, anunciante o proveedor."), ["kind"]);
  });
});
