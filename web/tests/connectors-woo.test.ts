// Set puro Woo/futuros proveedores: sin BD ni red.
// Corre con: npm test (node:test stdlib vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSyncOnLogin } from "@/lib/login-sync";
import { toSafeConnections, type StoreConnections } from "@/lib/store";
import { marketsToRegions } from "@/lib/connectors/types";
import { modeCountry, resolveOrderCountry } from "@/lib/canonical";

const BASE: StoreConnections = {
  platform: "medusa",
  medusaUrl: "",
  medusaVersion: "",
  medusaEmail: "",
  medusaToken: "",
  shopifyStore: "",
  shopifyToken: "",
  wooStore: "",
  wooConsumerKey: "",
  wooConsumerSecret: "",
  emailProvider: "sendgrid",
  emailFrom: "",
  emailApiKey: "",
  defaultChannel: "email",
};

describe("login-sync sin backend", () => {
  it("woocommerce → sin-backend (no sync)", () => {
    assert.deepEqual(
      shouldSyncOnLogin(
        { platform: "woocommerce", medusaUrl: "", medusaToken: "" },
        { supabaseConfigured: true, hasRunningRun: false },
      ),
      { sync: false, reason: "sin-backend" },
    );
  });

  it("shopify conserva alias legacy shopify-sin-backend", () => {
    assert.deepEqual(
      shouldSyncOnLogin(
        { platform: "shopify", medusaUrl: "", medusaToken: "" },
        { supabaseConfigured: true, hasRunningRun: false },
      ),
      { sync: false, reason: "shopify-sin-backend" },
    );
  });
});

describe("toSafeConnections con Woo", () => {
  it("expone wooStore + flags sin filtrar secretos", () => {
    const safe = toSafeConnections({
      ...BASE,
      wooStore: "https://tienda.com",
      wooConsumerKey: "ck_123",
      wooConsumerSecret: "cs_456",
    });
    assert.equal(safe.wooStore, "https://tienda.com");
    assert.equal(safe.hasWooConsumerKey, true);
    assert.equal(safe.hasWooConsumerSecret, true);
    assert.ok(!("wooConsumerKey" in safe) || (safe as Record<string, unknown>).wooConsumerKey === undefined);
  });

  it("flags en false sin credenciales", () => {
    const safe = toSafeConnections(BASE);
    assert.equal(safe.hasWooConsumerKey, false);
    assert.equal(safe.hasWooConsumerSecret, false);
  });
});

describe("mercados vacíos (Woo sin regiones)", () => {
  it("marketsToRegions([]) → {} sin romper", () => {
    assert.deepEqual(marketsToRegions([]), {});
  });
});

describe("reglas canónicas puras", () => {
  it("modeCountry desempata alfabético y null sin votos", () => {
    assert.equal(modeCountry(new Map([["MX", 2], ["PE", 2]])), "MX");
    assert.equal(modeCountry(new Map()), null);
  });

  it("resolveOrderCountry: crudo > market único > nombre > null", () => {
    assert.equal(resolveOrderCountry("pe", null), "PE");
    assert.equal(resolveOrderCountry(null, { name: "x", countries: ["PE"] }), "PE");
    assert.equal(resolveOrderCountry(null, { name: "MX", countries: [] }), "MX");
    assert.equal(resolveOrderCountry(null, null), null);
  });
});
