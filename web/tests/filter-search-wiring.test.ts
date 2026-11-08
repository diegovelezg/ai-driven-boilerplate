// Guardián anti-parpadeo: las 5 listas con buscador usan el FilterSearch
// compartido (único dueño del debounce + sync URL↔input) con la q del
// servidor como source of truth. Sin debounce local duplicado.
// Corre con: npm test (node:test vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "app", "(dashboard)");

const LISTS = [
  "screens/screens-list.tsx",
  "contacts/contacts-list.tsx",
  "companies/companies-list.tsx",
  "brands/brands-list.tsx",
  "orders/orders-list.tsx",
];

describe("buscador sin flash (FilterSearch compartido)", () => {
  for (const rel of LISTS) {
    it(`${rel} usa el FilterSearch compartido con initialValue={q}`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      assert.ok(
        src.includes('from "@/components/filter-search"'),
        `${rel}: debe importar el FilterSearch compartido`,
      );
      assert.ok(src.includes("<FilterSearch"), `${rel}: debe renderizar <FilterSearch`);
      assert.ok(
        src.includes("initialValue={q}"),
        `${rel}: el input se hidrata con la q del servidor (source of truth)`,
      );
    });

    it(`${rel} no tiene debounce local (el único vive en FilterSearch)`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      assert.ok(!src.includes("setTimeout"), `${rel}: sin setTimeout propio para el buscador`);
    });
  }

  it("el picker de pantallas de nueva orden es local (sin URL: inmune por construcción)", () => {
    const src = readFileSync(join(ROOT, "orders", "new", "nueva-form.tsx"), "utf8");
    assert.ok(!src.includes("filter-search"), "el picker no usa FilterSearch ni URL");
  });
});
