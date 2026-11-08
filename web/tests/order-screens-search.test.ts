// Picker de pantallas (nueva orden): mismo fuzzy que la vista principal de
// screens — normalización ES + tokens AND + ranking. El haystack es
// nombre + detalle (el detalle ya trae código, sede, distrito, ciudad,
// proveedor, tecnología y resolución).
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterPickScreens,
  pickScreenHaystack,
} from "@/lib/screen-pick";

const screens = [
  { id: "1", name: "Pantalla LED — Av. Ejército", detail: "MI001 · Estadio Bonilla · Miraflores · Lima · SmartMedia · digital · 1920×1080", price_pen: 100 },
  { id: "2", name: "Panel Norte", detail: "PN002 · Real Plaza · San Isidro · Lima · Prisma · digital · 1080×1920", price_pen: 200 },
  { id: "3", name: "Valla Sur", detail: "VS003 · Óvalo · Cusco · Cusco · Andina · static · ", price_pen: 300 },
];

describe("picker de pantallas (nueva orden): fuzzy como screens", () => {
  it("haystack junta nombre + detalle normalizados", () => {
    const hay = pickScreenHaystack(screens[0]);
    for (const t of ["ejercito", "miraflores", "lima", "smartmedia", "mi001", "bonilla"]) {
      assert.ok(hay.includes(t), `falta ${t} en ${hay}`);
    }
  });

  it("tildes y mayúsculas no importan", () => {
    assert.deepEqual(filterPickScreens(screens, "EJERCITO").map((s) => s.id), ["1"]);
    assert.deepEqual(filterPickScreens(screens, "ovalo cusco").map((s) => s.id), ["3"]);
  });

  it("multi-token en desorden calza si todos están", () => {
    assert.deepEqual(filterPickScreens(screens, "bonilla ejercito").map((s) => s.id), ["1"]);
    assert.deepEqual(filterPickScreens(screens, "lima smartmedia").map((s) => s.id), ["1"]);
  });

  it("código, proveedor o ciudad recuperan la pantalla", () => {
    assert.deepEqual(filterPickScreens(screens, "mi001").map((s) => s.id), ["1"]);
    assert.deepEqual(filterPickScreens(screens, "prisma").map((s) => s.id), ["2"]);
    assert.deepEqual(filterPickScreens(screens, "cusco").map((s) => s.id), ["3"]);
  });

  it("un token ausente descarta", () => {
    assert.deepEqual(filterPickScreens(screens, "ejercito cusco"), []);
  });

  it("sin query devuelve todo en orden (sin filtro)", () => {
    assert.deepEqual(filterPickScreens(screens, "   ").map((s) => s.id), ["1", "2", "3"]);
  });

  it("con búsqueda: relevancia primero (prefijo del query completo)", () => {
    const rows = [
      { id: "a", name: "Otra pantalla", detail: "XX · grupo lima norte", price_pen: 1 },
      { id: "b", name: "Lima centro LED", detail: "YY · cercado", price_pen: 1 },
    ];
    assert.deepEqual(filterPickScreens(rows, "lima").map((s) => s.id), ["b", "a"]);
  });
});
