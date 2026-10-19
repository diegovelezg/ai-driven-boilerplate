// Filtro global por país/mercado: resolver, scope y predicados.
// Corre con: npm test  (node:test stdlib vía tsx, sin dependencias nuevas).
// Cubre solo lógica pura (sin BD): el wiring a Supabase se verifica en runtime.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  medusaOrderToCanonical,
  modeCountry,
  resolveOrderCountry,
} from "@/lib/medusa";
import {
  applyScopeFilter,
  displayMarket,
  effectiveScopeFilter,
  isEmptyScope,
  marketCountry,
  pickRequestedMarket,
  withMarketParam,
  type TenantMarket,
} from "@/lib/market-utils";

const PE: TenantMarket = { id: "m-pe", name: "PE", currency: "pen", countries: [] };
const MX: TenantMarket = { id: "m-mx", name: "MX", currency: "mxn", countries: [] };

describe("resolveOrderCountry (cascada medusa v1/v2 + shopify)", () => {
  it("prioriza shipping sobre billing", () => {
    assert.equal(resolveOrderCountry("pe", null), "PE");
    assert.equal(
      resolveOrderCountry(null, { name: "PE", countries: [] }),
      "PE",
    );
  });

  it("normaliza minúsculas y espacios", () => {
    assert.equal(resolveOrderCountry(" mx ", { name: "PE", countries: [] }), "MX");
  });

  it("ignora valores no-ISO2 y cae al market", () => {
    assert.equal(resolveOrderCountry("Peru", { name: "PE", countries: [] }), "PE");
    assert.equal(resolveOrderCountry("", { name: "PE", countries: [] }), "PE");
  });

  it("usa market.countries con un único ISO2", () => {
    assert.equal(resolveOrderCountry(null, { name: "Europa", countries: ["es"] }), "ES");
  });

  it("multi-país o sin datos → null (comodín, nunca adivina)", () => {
    assert.equal(resolveOrderCountry(null, { name: "Latam", countries: ["PE", "MX"] }), null);
    assert.equal(resolveOrderCountry(null, { name: "Latam", countries: [] }), null);
    assert.equal(resolveOrderCountry(null, null), null);
    assert.equal(resolveOrderCountry("XX1", null), null);
  });
});

describe("medusaOrderToCanonical integra el resolver", () => {
  const raw = {
    id: "o1",
    currency_code: "pen",
    email: "a@b.c",
    customer_id: "c1",
    region: { id: "reg_1", name: "PE" },
    shipping_address: { country_code: null },
    billing_address: { country_code: null },
    items: [],
  };
  it("deriva PE del nombre de región sin direcciones", () => {
    const o = medusaOrderToCanonical(raw, {
      reg_1: { name: "PE", currency: "pen", countries: [] },
    });
    assert.equal(o?.country, "PE");
    assert.equal(o?.market?.name, "PE");
  });

  it("el country crudo manda sobre el market", () => {
    const o = medusaOrderToCanonical(
      { ...raw, shipping_address: { country_code: "cl" } },
      { reg_1: { name: "PE", currency: "pen", countries: [] } },
    );
    assert.equal(o?.country, "CL");
  });
});

describe("modeCountry (moda con desempate alfabético)", () => {
  it("gana la mayoría", () => {
    assert.equal(modeCountry(new Map([["PE", 3], ["MX", 1]])), "PE");
  });
  it("empate → alfabético (determinista, igual que el SQL)", () => {
    assert.equal(modeCountry(new Map([["PE", 2], ["MX", 2]])), "MX");
  });
  it("vacío → null", () => {
    assert.equal(modeCountry(new Map()), null);
  });
});

describe("marketCountry / displayMarket", () => {
  it("countries único manda", () => {
    assert.equal(marketCountry({ name: "Europa", countries: ["ES"] }), "ES");
  });
  it("nombre ISO2 como fallback", () => {
    assert.equal(marketCountry({ name: "mx", countries: [] }), "MX");
  });
  it("multi-país o sin zona → null", () => {
    assert.equal(marketCountry({ name: "Latam", countries: ["PE", "MX"] }), null);
    assert.equal(marketCountry({ name: "Global", countries: [] }), null);
  });
  it("etiqueta país + moneda", () => {
    assert.equal(displayMarket(PE), "PE · PEN");
    assert.equal(
      displayMarket({ id: "x", name: "Latam", currency: "usd", countries: ["PE", "MX"] }),
      "Latam · USD",
    );
  });
  it("pickRequestedMarket valida contra la lista", () => {
    assert.equal(pickRequestedMarket([PE, MX], MX.id), MX);
    assert.equal(pickRequestedMarket([PE, MX], "otro"), null);
    assert.equal(pickRequestedMarket([PE, MX], null), null);
  });
  it("withMarketParam pone y quita", () => {
    assert.equal(withMarketParam("/review", "abc"), "/review?market=abc");
    assert.equal(withMarketParam("/customers?q=x&market=abc", null), "/customers?q=x");
  });
});

describe("effectiveScopeFilter / isEmptyScope", () => {
  it("sin scope → sin filtro", () => {
    assert.deepEqual(effectiveScopeFilter(null), { countries: null, ids: null });
    assert.equal(isEmptyScope(null), false);
    assert.equal(
      isEmptyScope({ countries: null, customerIds: null }),
      false,
    );
  });
  it("countries manda sobre ids", () => {
    assert.deepEqual(
      effectiveScopeFilter({ countries: ["PE"], customerIds: ["a"] }),
      { countries: ["PE"], ids: null },
    );
  });
  it("fallback a ids solo sin países", () => {
    assert.deepEqual(
      effectiveScopeFilter({ countries: [], customerIds: ["a", "b"] }),
      { countries: null, ids: ["a", "b"] },
    );
  });
  it("filtrando sin nadie → vacío (pasan solo los sin país)", () => {
    assert.equal(
      isEmptyScope({ countries: [], customerIds: [] }),
      true,
    );
    assert.equal(
      isEmptyScope({ countries: ["PE"], customerIds: null }),
      false,
    );
  });
});

describe("applyScopeFilter (SQL generado)", () => {
  // Builder falso: registra or()/is() sin tocar red.
  const fake = () => {
    const calls: Array<{ fn: string; arg: string }> = [];
    return {
      calls,
      q: {
        or: (arg: string) => (calls.push({ fn: "or", arg }), "OR"),
        is: (col: string, v: null) => (calls.push({ fn: `is:${col}`, arg: String(v) }), "IS"),
      },
    };
  };

  it("sin scope devuelve el query intacto", () => {
    const { q } = fake();
    assert.equal(applyScopeFilter(q, null), q);
  });

  it("países → OR con comodín NULL", () => {
    const { q, calls } = fake();
    applyScopeFilter(q, { countries: ["PE", "MX"], customerIds: null });
    assert.deepEqual(calls, [{ fn: "or", arg: "country.in.(PE,MX),country.is.null" }]);
  });

  it("fallback ids usa la columna indicada + comodín", () => {
    const { q, calls } = fake();
    applyScopeFilter(q, { countries: [], customerIds: ["a", "b"] }, "id");
    assert.deepEqual(calls, [{ fn: "or", arg: "id.in.(a,b),country.is.null" }]);
  });

  it("leads (sin columna de IDs) no usan ids: solo sin país", () => {
    const { q, calls } = fake();
    applyScopeFilter(q, { countries: [], customerIds: ["a"] }, null);
    assert.deepEqual(calls, [{ fn: "is:country", arg: "null" }]);
  });

  it("scope vacío → solo sin país", () => {
    const { q, calls } = fake();
    applyScopeFilter(q, { countries: [], customerIds: [] });
    assert.deepEqual(calls, [{ fn: "is:country", arg: "null" }]);
  });
});
