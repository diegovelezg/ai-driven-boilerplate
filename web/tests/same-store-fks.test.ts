// Same-store FKs (20261213000000): guardrail sin DB.
// Verifica que la migración cubra cada FK entre tenants con pre-chequeo
// fail-closed + UNIQUE(store_id,id) + FK compuesta + trigger home_company.
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SQL = readFileSync(
  join(ROOT, "../supabase/migrations/20261213000000_same_store_fks.sql"),
  "utf8",
);

// [constraint, tabla hija, tabla padre]
const FKS: Array<[string, string, string]> = [
  ["crm_contacts_company_same_store_fk", "crm_contacts", "crm_companies"],
  ["inv_venues_company_same_store_fk", "inv_venues", "crm_companies"],
  ["inv_venues_supplier_same_store_fk", "inv_venues", "crm_companies"],
  ["inv_screens_venue_same_store_fk", "inv_screens", "inv_venues"],
  ["inv_screens_supplier_same_store_fk", "inv_screens", "crm_companies"],
  ["inv_slots_screen_same_store_fk", "inv_slots", "inv_screens"],
  ["inv_slots_loop_same_store_fk", "inv_slots", "inv_loop_templates"],
  ["inv_screen_embeddings_screen_same_store_fk", "inv_screen_embeddings", "inv_screens"],
  ["io_campaigns_advertiser_same_store_fk", "io_campaigns", "crm_companies"],
  ["io_campaigns_io_same_store_fk", "io_campaigns", "io_orders"],
  ["io_campaigns_contact_same_store_fk", "io_campaigns", "crm_contacts"],
  ["inv_bookings_slot_same_store_fk", "inv_bookings", "inv_slots"],
  ["inv_bookings_campaign_same_store_fk", "inv_bookings", "io_campaigns"],
  ["inv_bookings_io_same_store_fk", "inv_bookings", "io_orders"],
  ["io_orders_advertiser_same_store_fk", "io_orders", "crm_companies"],
  ["io_orders_billing_same_store_fk", "io_orders", "crm_companies"],
  ["io_lines_io_same_store_fk", "io_lines", "io_orders"],
  ["io_lines_screen_same_store_fk", "io_lines", "inv_screens"],
  ["io_lines_slot_same_store_fk", "io_lines", "inv_slots"],
  ["io_agency_orders_io_same_store_fk", "io_agency_orders", "io_orders"],
  ["io_creatives_io_same_store_fk", "io_creatives", "io_orders"],
  ["io_photo_checks_io_same_store_fk", "io_photo_checks", "io_orders"],
  ["io_photo_checks_screen_same_store_fk", "io_photo_checks", "inv_screens"],
  ["io_play_logs_io_same_store_fk", "io_play_logs", "io_orders"],
  ["io_play_logs_screen_same_store_fk", "io_play_logs", "inv_screens"],
  ["io_play_logs_slot_same_store_fk", "io_play_logs", "inv_slots"],
  ["io_invoices_io_same_store_fk", "io_invoices", "io_orders"],
];

const PARENT_UQS = [
  "crm_companies",
  "crm_contacts",
  "inv_venues",
  "inv_screens",
  "inv_loop_templates",
  "inv_slots",
  "io_orders",
  "io_campaigns",
];

describe("same-store FKs: cobertura total orders/inventario/CRM", () => {
  it("cada FK compuesta existe y referencia (store_id, id)", () => {
    assert.equal(FKS.length, 27, "27 FKs same-store esperadas");
    for (const [name, child, parent] of FKS) {
      assert.ok(SQL.includes(`conname = '${name}'`), `${name}: idempotencia por pg_constraint`);
      assert.ok(
        SQL.includes(`alter table ${child} add constraint ${name} foreign key (store_id,`),
        `${name}: FK compuesta en ${child}`,
      );
      assert.ok(
        SQL.includes(`references ${parent} (store_id, id)`),
        `${name}: referencia ${parent}(store_id, id)`,
      );
    }
  });
  it("padres con UNIQUE(store_id, id) para el target del FK", () => {
    for (const t of PARENT_UQS) {
      assert.ok(SQL.includes(`alter table ${t} add constraint ${t}_store_uq unique (store_id, id)`), `${t}: UQ`);
    }
  });
  it("pre-chequeo fail-closed cubre cada par (RAISE antes de crear)", () => {
    const raises = SQL.match(/same-store bloqueado/g) ?? [];
    assert.ok(raises.length >= FKS.length, `${raises.length} pre-chequeos >= ${FKS.length} FKs`);
  });
  it("sys_stores.home_company_id blindado con trigger (dirección inversa)", () => {
    assert.match(SQL, /check_sys_store_home_company/, "función trigger presente");
    assert.match(SQL, /sys_stores_home_company_same_store/, "trigger en sys_stores presente");
  });
  it("FKs check-only: sin ON DELETE CASCADE/SET NULL (el borrado lo rige la FK original)", () => {
    const bodies = [...SQL.matchAll(/add constraint \w+ foreign key \(store_id,[\s\S]+?;/g)].map((m) => m[0]);
    assert.equal(bodies.length, FKS.length, "27 cuerpos FK");
    for (const b of bodies) {
      assert.match(b, /on delete no action/i, `check-only: ${b.slice(0, 60)}…`);
      assert.doesNotMatch(b, /on delete (cascade|set null)/i, `sin acción de borrado: ${b.slice(0, 60)}…`);
    }
  });
});
