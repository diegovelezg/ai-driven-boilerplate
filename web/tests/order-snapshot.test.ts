// Snapshot de NP al firmar: foto inmutable de contrapartes (resiste archivo
// o cambio de empresas/contactos). El PDF la prefiere al dato vivo.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOrderSnapshot, parseOrderSnapshot } from "@/lib/order-snapshot";

const BASE = {
  signed_at: "2026-11-04T00:00:00-05:00",
  currency: "PEN",
  payment_terms_days: 30,
  gross_minor: 500000,
  advertiser_name: "Hipermercados Tottus S.A.",
  billing_name: "Hipermercados Tottus S.A.",
  billing_tax_id: "20508565934",
  billing_city: "Lima",
  billing_country: "PE",
  agency_name: "PUBLICIS GROUPE MEDIA PERU SAC",
  agency_tax_id: "20476465614",
  agency_commission_pct: 15,
  billing_contact: { name: "Milu Palacios", role: "Supervisor", email: "milu.palacios@starcomww.com", phone: null },
  signer_contact: { name: "Milu Palacios", role: "Supervisor", email: "milu.palacios@starcomww.com", phone: null },
  payment_contact: { name: "Lázaro Cabezas", role: null, email: "lcabezas@tottus.com.pe", phone: null },
  manager_contact: null,
};

describe("order snapshot", () => {
  it("congela contrapartes, agencia y contactos al firmar", () => {
    const s = buildOrderSnapshot(BASE);
    assert.equal(s.v, 1);
    assert.equal(s.advertiser.name, "Hipermercados Tottus S.A.");
    assert.equal(s.billing.tax_id, "20508565934");
    assert.equal(s.agency?.commission_pct, 15);
    assert.equal(s.contacts.billing?.email, "milu.palacios@starcomww.com");
    assert.equal(s.contacts.manager, null);
    assert.equal(s.gross_minor, 500000);
  });

  it("sin agencia vinculada no hay bloque agencia", () => {
    const s = buildOrderSnapshot({ ...BASE, agency_name: null, agency_tax_id: null, agency_commission_pct: null });
    assert.equal(s.agency, null);
  });

  it("round-trip tolerante: inválidos dan null, nunca lanzan", () => {
    const s = buildOrderSnapshot(BASE);
    assert.deepEqual(parseOrderSnapshot(JSON.parse(JSON.stringify(s))), s);
    assert.equal(parseOrderSnapshot(null), null);
    assert.equal(parseOrderSnapshot({}), null);
    assert.equal(parseOrderSnapshot({ v: 2 }), null);
    assert.equal(parseOrderSnapshot({ v: 1 }), null);
  });
});
