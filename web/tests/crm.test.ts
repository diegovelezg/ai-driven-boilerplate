// CRM base: un tipo por empresa + marca como metadato del pedido.
// Corre con: npm test (node:test vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMPANY_KIND_LABELS,
  companyKindsLabel,
  isCompanyKind,
  isDefaultCompanyKinds,
  kindLabel,
  normalizeCompany,
  normalizeContact,
  normalizeDomain,
  parseCompanyKinds,
  serializeCompanyKinds,
} from "@/lib/crm";

describe("crm kinds", () => {
  it("agencia / anunciante / proveedor son los únicos tipos", () => {
    assert.equal(isCompanyKind("agencia"), true);
    assert.equal(isCompanyKind("anunciante"), true);
    assert.equal(isCompanyKind("proveedor"), true);
    assert.equal(isCompanyKind("customer"), false);
    assert.equal(isCompanyKind("cliente"), false);
    assert.equal(COMPANY_KIND_LABELS.agencia, "Agencia");
    assert.equal(COMPANY_KIND_LABELS.proveedor, "Proveedor");
    // La casa no lista: null legacy se muestra como "—".
    assert.equal(kindLabel(null), "—");
    assert.equal(kindLabel("agencia"), "Agencia");
  });
});

describe("company kinds multiselect", () => {
  it("sin parámetro → default agencia + anunciante (sin proveedor)", () => {
    assert.deepEqual(parseCompanyKinds(undefined), ["agencia", "anunciante"]);
    assert.deepEqual(parseCompanyKinds(null), ["agencia", "anunciante"]);
  });

  it("acepta repetido, coma y legacy single", () => {
    assert.deepEqual(parseCompanyKinds("proveedor"), ["proveedor"]);
    assert.deepEqual(parseCompanyKinds("agencia,proveedor"), ["agencia", "proveedor"]);
    assert.deepEqual(parseCompanyKinds(["agencia", "anunciante"]), ["agencia", "anunciante"]);
    assert.deepEqual(parseCompanyKinds(["agencia,proveedor"]), ["agencia", "proveedor"]);
  });

  it("all → los 3; none → ninguno; inválido → default", () => {
    assert.deepEqual(parseCompanyKinds("all"), ["agencia", "anunciante", "proveedor"]);
    assert.deepEqual(parseCompanyKinds("none"), []);
    assert.deepEqual(parseCompanyKinds("invalido"), ["agencia", "anunciante"]);
  });

  it("serialize: default se omite; resto explícito", () => {
    assert.equal(serializeCompanyKinds(["agencia", "anunciante"]), null);
    assert.equal(serializeCompanyKinds(["anunciante", "agencia"]), null);
    assert.equal(serializeCompanyKinds(["agencia", "anunciante", "proveedor"]), "agencia,anunciante,proveedor");
    assert.equal(serializeCompanyKinds(["proveedor"]), "proveedor");
    assert.equal(serializeCompanyKinds([]), "none");
  });

  it("label e isDefault", () => {
    assert.equal(isDefaultCompanyKinds(["agencia", "anunciante"]), true);
    assert.equal(isDefaultCompanyKinds(["agencia"]), false);
    assert.equal(companyKindsLabel(["agencia", "anunciante"]), "Agencia, Anunciante");
    assert.equal(companyKindsLabel(["agencia", "anunciante", "proveedor"]), "Todo tipo");
    assert.equal(companyKindsLabel([]), "Sin tipo");
  });
});
describe("normalizeCompany", () => {
  it("exige nombre y normaliza dominio", () => {
    assert.equal(normalizeCompany({ name: "  " }).ok, false);
    const r = normalizeCompany({ name: " Acme S.A.C. ", kind: "anunciante", domain: "https://WWW.acme.pe/web" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.name, "Acme S.A.C.");
      assert.equal(r.value.domain, "acme.pe");
    }
  });

  it("rechaza email y dominio inválidos", () => {
    assert.equal(normalizeCompany({ name: "Acme", kind: "agencia", email: "no-es-email" }).ok, false);
    assert.equal(normalizeCompany({ name: "Acme", kind: "agencia", domain: "sin-punto" }).ok, false);
  });

  it("conserva external_ref para idempotencia Sheet/CSV", () => {
    const r = normalizeCompany({ name: "Acme", kind: "proveedor", external_ref: " acme-001 " });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.external_ref, "acme-001");
    assert.equal(normalizeCompany({ name: "Acme", kind: "proveedor", external_ref: "   " }).ok, false);
  });

  it("exige kind (la casa no es empresa del CRM)", () => {
    assert.equal(normalizeCompany({ name: "Acme" }).ok, false);
    assert.equal(normalizeCompany({ name: "Acme", kind: null }).ok, false);
    const k = normalizeCompany({ name: "Acme", kind: "agencia" });
    assert.equal(k.ok, true);
    if (k.ok) assert.equal(k.value.kind, "agencia");
    assert.equal(normalizeCompany({ name: "Acme", kind: "cliente" as never }).ok, false);
  });
});

describe("normalizeContact", () => {
  it("exige email o teléfono (N contactos por empresa)", () => {
    assert.equal(normalizeContact({ company_id: "c1" }).ok, false);
    const r = normalizeContact({ company_id: "c1", email: "ana@acme.pe", is_primary: true });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.is_primary, true);
  });
});

describe("normalizeDomain", () => {
  it("lowercase + sin www ni path", () => {
    assert.equal(normalizeDomain("  WWW.Acme.PE/contacto "), "acme.pe");
    assert.equal(normalizeDomain("sin-punto"), null);
  });
});
