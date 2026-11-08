// Fidelidad del enriquecimiento (issue #1): hoteles fuera de ptsNodos,
// congestión "unknown" sin muestras reales, tilequery con layers.
// Corre con: npm test (node:test stdlib vía tsx).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { analyzeCoordinates } from "../lib/screens-enrich";

const realFetch = globalThis.fetch;

function mockFetch() {
  const hotels = Array.from({ length: 7 }, (_, i) => ({
    properties: { name: `Hotel ${i + 1}`, distance: 50 + i * 5, place_formatted: "San Isidro" },
  }));
  // @ts-expect-error mock mínimo para fetchJson
  globalThis.fetch = async (url: string) => {
    const u = String(url);
    const json = async () => {
      if (u.includes("mapbox.places")) {
        return {
          features: [
            { place_type: ["address"], text: "Av. Dos de Mayo 1836", place_name: "Av. Dos de Mayo 1836, San Isidro, Lima, Perú" },
            { place_type: ["locality"], text: "San Isidro" },
            { place_type: ["place"], text: "Lima" },
            { place_type: ["region"], text: "Lima" },
          ],
        };
      }
      if (u.includes("/category/hotel?")) return { features: hotels };
      if (u.includes("/category/")) return { features: [] };
      if (u.includes("tilequery")) {
        return {
          features: [
            { properties: { tilequery: { layer: "road" }, class: "street" } },
          ],
        };
      }
      if (u.includes("directions")) {
        return {
          routes: [{ legs: [{ annotation: { congestion: ["unknown", "unknown"], speed: [7, 7] } }] }],
        };
      }
      return { features: [] };
    };
    return { ok: true, json };
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("enriquecimiento geoespacial (issue #1)", () => {
  it("tilequery pide layers=road,landuse,building", async () => {
    const seen: string[] = [];
    // @ts-expect-error mock mínimo
    globalThis.fetch = async (url: string) => {
      seen.push(String(url));
      return { ok: false, json: async () => ({}) };
    };
    await analyzeCoordinates(-12.092678, -77.050346, "pk.test").catch(() => {});
    const tile = seen.find((u) => u.includes("tilequery"));
    assert.ok(tile, "debe llamar a tilequery");
    assert.ok(tile.includes("layers=road,landuse,building"), `sin layers: ${tile}`);
  });

  it("hoteles no cuentan como nodos de transporte (P1b)", async () => {
    mockFetch();
    const geo = await analyzeCoordinates(-12.092678, -77.050346, "pk.test");
    // street → jerarquía 15 + 0 nodos + 0 cruces + 5 = 20 (antes 50 con hoteles).
    assert.equal(geo.trafficScore, 20);
    assert.equal(geo.congestionLevel, "unknown");
  });

  it("congestión unknown cuando todo es unknown (P1a)", async () => {
    mockFetch();
    const geo = await analyzeCoordinates(-12.092678, -77.050346, "pk.test");
    assert.notEqual(geo.congestionLevel, "low");
    assert.equal(geo.congestionLevel, "unknown");
  });
});
