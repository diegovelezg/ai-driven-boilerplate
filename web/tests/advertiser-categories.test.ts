// Categorías IAB de anunciante: SSOT + validación en normalizeCompany.
// Corre con: npm test (node:test vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ADVERTISER_CATEGORIES,
  advertiserCategoryLabel,
  advertiserCategoryNameEn,
  isAdvertiserCategory,
} from "@/lib/advertiser-categories";
import { normalizeCompany } from "@/lib/crm";

describe("advertiser categories", () => {
  it("24 códigos IAB1–IAB24 con EN + ES", () => {
    assert.equal(ADVERTISER_CATEGORIES.length, 24);
    assert.equal(ADVERTISER_CATEGORIES[1].code, "IAB2");
    assert.equal(ADVERTISER_CATEGORIES[1].name_en, "Automotive");
    assert.equal(ADVERTISER_CATEGORIES[1].name_es, "Automotriz");
    assert.equal(ADVERTISER_CATEGORIES[7].code, "IAB8");
    assert.equal(ADVERTISER_CATEGORIES[7].name_es, "Alimentos y Bebidas");
  });

  it("guard + etiquetas", () => {
    assert.equal(isAdvertiserCategory("IAB1"), true);
    assert.equal(isAdvertiserCategory("IAB24"), true);
    assert.equal(isAdvertiserCategory("IAB25"), false);
    assert.equal(isAdvertiserCategory("retail"), false);
    assert.equal(advertiserCategoryLabel("IAB2"), "Automotriz");
    assert.equal(advertiserCategoryNameEn("IAB2"), "Automotive");
    assert.equal(advertiserCategoryLabel("IAB99"), null);
    assert.equal(advertiserCategoryLabel(null), null);
  });
});

describe("normalizeCompany category_iab", () => {
  it("acepta vacío (null) y código válido", () => {
    const r = normalizeCompany({ name: "Acme", legal_name: "Acme S.A.C.", kind: "anunciante", tax_id: "20123456789", address: "Av. Arequipa 123", city: "Lima", country: "PE" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.category_iab, null);
    const ok = normalizeCompany({ name: "Acme", legal_name: "Acme S.A.C.", kind: "anunciante", tax_id: "20123456789", address: "Av. Arequipa 123", city: "Lima", country: "PE", category_iab: "IAB2" });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.category_iab, "IAB2");
  });

  it("normaliza minúsculas y rechaza código inválido", () => {
    const r = normalizeCompany({ name: "Acme", legal_name: "Acme S.A.C.", kind: "anunciante", tax_id: "20123456789", address: "Av. Arequipa 123", city: "Lima", country: "PE", category_iab: "iab8" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.category_iab, "IAB8");
    assert.equal(normalizeCompany({ name: "Acme", legal_name: "Acme S.A.C.", kind: "anunciante", tax_id: "20123456789", address: "Av. Arequipa 123", city: "Lima", country: "PE", category_iab: "IAB99" }).ok, false);
  });
});
