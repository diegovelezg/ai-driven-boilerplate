// Búsqueda en inventario: normalización ES + tokens AND (paridad TS del RPC
// `inv_search_screens`). Sin BD: puro y determinista.
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  matchScreenTokens,
  normalizeSearch,
  screenHaystack,
  tokenizeSearch,
} from "@/lib/screens-db";

describe("normalizeSearch", () => {
  it("tildes, mayúsculas y espacios colapsan", () => {
    assert.equal(normalizeSearch("Av. Ejército  / Estadio"), "av. ejercito / estadio");
    assert.equal(normalizeSearch("Paseo de la República"), "paseo de la republica");
    assert.equal(normalizeSearch("  Miraflores\t\nAlto  "), "miraflores alto");
  });

  it("ñ y diéresis degradan a ASCII", () => {
    assert.equal(normalizeSearch("NIÑO"), "nino");
    assert.equal(normalizeSearch("pingüino"), "pinguino");
  });

  it("null/undefined → vacío, sin lanzar", () => {
    assert.equal(normalizeSearch(null), "");
    assert.equal(normalizeSearch(undefined), "");
    assert.equal(normalizeSearch(123), "123");
  });
});

describe("tokenizeSearch", () => {
  it("parte por espacios y filtra vacíos", () => {
    assert.deepEqual(tokenizeSearch("  Bonilla   Ejercito "), ["bonilla", "ejercito"]);
  });

  it("vacío → sin tokens", () => {
    assert.deepEqual(tokenizeSearch("   "), []);
  });

  it("tope 6 tokens (paridad con el RPC)", () => {
    assert.equal(tokenizeSearch("a b c d e f g h").length, 6);
  });
});

describe("screenHaystack + matchScreenTokens", () => {
  const row = {
    name: "Pantalla LED — Av. Ejército / Estadio Bonilla",
    district: "Miraflores",
    city: "Lima",
    venue_name: "Estadio Bonilla",
    supplier_name: "SmartMedia",
    external_ref: "MI001",
  };

  it("haystack junta los 6 campos normalizados", () => {
    const hay = screenHaystack(row);
    for (const t of ["ejercito", "miraflores", "lima", "smartmedia", "mi001"]) {
      assert.ok(hay.includes(t), `falta ${t} en ${hay}`);
    }
  });

  it("match AND: todos los tokens en cualquier orden y campo", () => {
    const hay = screenHaystack(row);
    assert.equal(matchScreenTokens(hay, tokenizeSearch("Bonilla Ejercito")), true);
    assert.equal(matchScreenTokens(hay, tokenizeSearch("lima smartmedia")), true);
    // Sin tildes matchea con tildes.
    assert.equal(matchScreenTokens(hay, tokenizeSearch("ejercito")), true);
    // Typo: lo cubre pg_trgm (%), no el fallback JS.
    assert.equal(matchScreenTokens(hay, tokenizeSearch("ejersito")), false);
  });

  it("un token ausente descarta la fila", () => {
    const hay = screenHaystack(row);
    assert.equal(matchScreenTokens(hay, tokenizeSearch("ejercito cusco")), false);
  });

  it("sin tokens todo matchea (sin filtro de texto)", () => {
    assert.equal(matchScreenTokens(screenHaystack(row), []), true);
  });

  it("código externo también indexa", () => {
    const hay = screenHaystack(row);
    assert.equal(matchScreenTokens(hay, tokenizeSearch("mi001")), true);
  });
});
