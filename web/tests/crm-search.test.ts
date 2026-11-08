// Mismo mecanismo fuzzy en CRM, marcas y órdenes: normalización ES +
// tokens AND + ranking. Marcas y órdenes filtran en JS (agregación y
// derivación viven ahí); empresas y contactos vía RPC con paridad.
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  joinHaystack,
  matchScore,
  matchTokens,
  normalizeSearch,
  tokenizeSearch,
} from "@/lib/search-text";

describe("matchScore", () => {
  it("sin query → 0 (sin filtro)", () => {
    assert.equal(matchScore("cualquier cosa", [], ""), 0);
  });

  it("token ausente → -1 (descarta)", () => {
    assert.equal(matchScore("tottus lima", ["tottus", "cusco"], "tottus cusco"), -1);
  });

  it("prefijo del query completo > substring > solo tokens", () => {
    const tokens = tokenizeSearch("tottus");
    const q = normalizeSearch("tottus");
    assert.equal(matchScore("tottus supermercados", tokens, q), 2);
    assert.equal(matchScore("grupo tottus", tokens, q), 1);
    assert.equal(matchScore("xtottus", ["tottus"], "tottus"), 1);
  });

  it("multi-token en desorden calza si todos están", () => {
    const tokens = tokenizeSearch("pardo espinar");
    assert.ok(matchScore(joinHaystack(["Av. Pardo", "Comandante Espinar"]), tokens, "pardo espinar") >= 0);
  });
});

describe("marcas: haystack marca + agencias + pantallas", () => {
  const hay = (brand: string, agencies: string[], screens: string[]) =>
    joinHaystack([brand, ...agencies, ...screens]);

  it("tildes y mayúsculas no importan", () => {
    const h = hay("Qroma", ["Havas Media"], ["MI001"]);
    assert.ok(matchTokens(h, tokenizeSearch("qroma")));
    assert.ok(matchTokens(h, tokenizeSearch("HAVAS")));
  });

  it("la agencia sola recupera la marca", () => {
    const h = hay("Toyota", ["Publicis"], ["Pantalla Norte"]);
    assert.ok(matchTokens(h, tokenizeSearch("publicis")));
    assert.ok(!matchTokens(h, tokenizeSearch("cusco")));
  });

  it("prefijo de marca rankea primero", () => {
    const tokens = tokenizeSearch("tot");
    const q = normalizeSearch("tot");
    const brandHit = matchScore(joinHaystack(["Tottus"]), tokens, q);
    const agencyHit = matchScore(joinHaystack(["Otra", "Agencia Tottus"]), tokens, q);
    assert.ok(brandHit > agencyHit);
  });
});

describe("órdenes: haystack IO + marca + empresas", () => {
  const hay = (io: string, brand: string | null, adv: string | null, bill: string | null) =>
    joinHaystack([io, brand, adv, bill]);

  it("IO exacto calza aunque marca y empresas difieran", () => {
    const h = hay("OI-2026-0001", "Qroma", "Tottus", "Starcom");
    assert.ok(matchTokens(h, tokenizeSearch("oi-2026-0001")));
  });

  it("la empresa anunciante recupera la orden (nuevo alcance)", () => {
    const h = hay("OI-2026-0001", "Qroma", "Tottus", "Starcom");
    assert.ok(matchTokens(h, tokenizeSearch("tottus")));
    assert.ok(matchTokens(h, tokenizeSearch("starcom")));
    assert.ok(!matchTokens(h, tokenizeSearch("cusco")));
  });

  it("tildes en nombres de empresa", () => {
    const h = hay("OI-1", null, "León y Asociados", null);
    assert.ok(matchTokens(h, tokenizeSearch("leon")));
  });
});

describe("contactos: haystack persona + empresa + teléfono", () => {
  it("teléfono y empresa también indexan", () => {
    const h = joinHaystack(["Milú", "Palacios", "milu.palacios@starcomww.com", "998139849", "Supervisor", "Starcom"]);
    assert.ok(matchTokens(h, tokenizeSearch("998139849")));
    assert.ok(matchTokens(h, tokenizeSearch("milu starcom")));
  });

  it("nombre parcial + empresa", () => {
    const h = joinHaystack(["Francisco", "García", "francisco.garcia@havasmn.com", null, "Planner", "Havas"]);
    assert.ok(matchTokens(h, tokenizeSearch("francisco havas")));
    assert.ok(matchTokens(h, tokenizeSearch("garcia")));
  });
});
