// Guardián de auditoría de órdenes: quién crea / edita / cambia estado.
// Patrón `*_by` (email de sesión, null sin sesión) como approved_by/closed_by.
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const readRepo = (p: string) => readFileSync(join(ROOT, "..", p), "utf8");

describe("auditoría de órdenes (actor)", () => {
  it("la migración agrega created_by/updated_by a insertion_orders", () => {
    const p = "supabase/migrations/20261118000000_io_actor_tracking.sql";
    assert.ok(existsSync(join(ROOT, "..", p)), `falta migración ${p}`);
    const src = readRepo(p);
    assert.ok(src.includes("created_by"), "migración sin created_by");
    assert.ok(src.includes("updated_by"), "migración sin updated_by");
  });

  it("resolveActor nunca inventa identidad (null sin sesión)", () => {
    const src = read("lib/actor.ts");
    assert.ok(src.includes("resolveActor"), "falta resolveActor");
    assert.ok(src.includes("auth.getUser"), "debe leer la sesión Supabase");
    assert.ok(src.includes("?? null"), "sin sesión debe quedar null");
  });

  it("crear orden sella created_by + updated_by", () => {
    const src = read("lib/order-actions.ts");
    assert.ok(src.includes("resolveActor"), "createOrderAction no resuelve actor");
    assert.ok(src.includes("created_by"), "insert sin created_by");
    assert.ok(src.includes("updated_by"), "insert sin updated_by");
  });

  it("el drawer muestra quién creó la orden", () => {
    const src = read("app/(dashboard)/orders/orden-drawer.tsx");
    assert.ok(src.includes("created_by"), "ficha sin creada por");
  });

  it("la migración agrega created_by/updated_by a companies y contacts", () => {
    const p = "supabase/migrations/20261119000000_crm_actor_tracking.sql";
    const src = readRepo(p);
    assert.ok(src.includes("alter table companies"), "migración sin companies");
    assert.ok(src.includes("alter table contacts"), "migración sin contacts");
    assert.ok(src.includes("created_by"), "migración sin created_by");
    assert.ok(src.includes("updated_by"), "migración sin updated_by");
  });

  it("empresas y contactos sellan actor al crear y al editar", () => {
    const src = read("lib/crm-actions.ts");
    assert.ok(src.includes("resolveActor"), "crm-actions sin resolver actor");
    const creates = (src.match(/created_by: actor/g) ?? []).length;
    assert.ok(creates >= 2, `create empresa/contacto sin sello (hallados ${creates})`);
    assert.ok(src.includes("updated_by"), "edits sin updated_by");
  });

  it("el drawer de empresa muestra quién la creó", () => {
    const src = read("app/(dashboard)/companies/empresa-drawer.tsx");
    assert.ok(src.includes("created_by"), "ficha empresa sin creada por");
  });
});
