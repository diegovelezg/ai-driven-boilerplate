// Tipos de proveedor DOOH: SSOT + regla kind = proveedor.
// Corre con: npm test (node:test vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_TYPES, isProviderType, providerTypeLabel } from "@/lib/provider-types";
import { normalizeCompany } from "@/lib/crm";

describe("provider types", () => {
  it("5 códigos con EN + ES (Exhibidor = media owner)", () => {
    assert.equal(PROVIDER_TYPES.length, 5);
    assert.equal(PROVIDER_TYPES[0].code, "media_owner");
    assert.equal(PROVIDER_TYPES[0].name_es, "Exhibidor");
    assert.equal(isProviderType("installation"), true);
    assert.equal(isProviderType("exhibicion"), false);
    assert.equal(providerTypeLabel("print_production"), "Impresión / Producción");
    assert.equal(providerTypeLabel("invalido"), null);
    assert.equal(providerTypeLabel(null), null);
  });
});

describe("normalizeCompany provider_type", () => {
  it("solo válido con kind = proveedor", () => {
    const ok = normalizeCompany({ name: "Andamios SAC", legal_name: "Andamios S.A.C.", kind: "proveedor", tax_id: "20123456789", address: "Av. Arequipa 123", city: "Lima", country: "PE", provider_type: "installation" });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.provider_type, "installation");
    assert.equal(normalizeCompany({ name: "Acme", legal_name: "Acme S.A.C.", kind: "proveedor", tax_id: "20123456789", address: "Av. Arequipa 123", city: "Lima", country: "PE" }).ok, true);
    assert.equal(normalizeCompany({ name: "Acme", legal_name: "Acme S.A.C.", kind: "anunciante", tax_id: "20123456789", address: "Av. Arequipa 123", city: "Lima", country: "PE", provider_type: "installation" }).ok, false);
    assert.equal(normalizeCompany({ name: "Acme", legal_name: "Acme S.A.C.", kind: "proveedor", tax_id: "20123456789", address: "Av. Arequipa 123", city: "Lima", country: "PE", provider_type: "invalido" }).ok, false);
  });
});
