// Picker de pantallas (nueva orden): mismo fuzzy que la vista principal de
// screens — normalización ES + tokens AND + ranking. El haystack es
// nombre + código + detalle (el detalle trae sede, distrito, ciudad,
// proveedor, tecnología y resolución; el código no se muestra en la fila,
// que muestra el precio, pero sigue recuperando por búsqueda).
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterPickScreens,
  pickScreenHaystack,
} from "@/lib/screen-pick";

const screens = [
  { id: "1", name: "Pantalla LED — Av. Ejército", code: "MI001", detail: "Estadio Bonilla · Miraflores · Lima · SmartMedia · digital · 1920×1080", price_pen: 100 },
  { id: "2", name: "Panel Norte", code: "PN002", detail: "Real Plaza · San Isidro · Lima · Prisma · digital · 1080×1920", price_pen: 200 },
  { id: "3", name: "Valla Sur", code: "VS003", detail: "Óvalo · Cusco · Cusco · Andina · static · ", price_pen: 300 },
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
      { id: "a", name: "Otra pantalla", code: "XX", detail: "grupo lima norte", price_pen: 1 },
      { id: "b", name: "Lima centro LED", code: "YY", detail: "cercado", price_pen: 1 },
    ];
    assert.deepEqual(filterPickScreens(rows, "lima").map((s) => s.id), ["b", "a"]);
  });
});
