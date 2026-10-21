// Contrato del layer de conectores: routing, error tipado, fuentes y reglas.
// Corre con: npm test (node:test stdlib vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getConnector, isConnectorSupported, SUPPORTED_CONNECTORS } from "@/lib/connectors";
import {
  ConnectorNotImplementedError,
  marketsToRegions,
  regionsToMarkets,
  toCredentials,
} from "@/lib/connectors/types";
import { medusaConnector } from "@/lib/connectors/medusa";
import { groupTotalsByCurrency, isRealOrder } from "@/lib/canonical";

describe("getConnector routing", () => {
  it("medusa resuelve con sources legacy intactos", () => {
    const c = getConnector("medusa");
    assert.equal(c.platform, "medusa");
    assert.equal(c.marketSource, "medusa_region");
    assert.equal(c.channelSource, "medusa_sales_channel");
    assert.equal(c.productSource, "medusa_product");
  });

  it("shopify lanza error tipado (no genérico)", () => {
    assert.throws(
      () => getConnector("shopify"),
      (e: unknown) => {
        assert.ok(e instanceof ConnectorNotImplementedError);
        assert.equal((e as ConnectorNotImplementedError).platform, "shopify");
        return true;
      },
    );
  });

  it("woocommerce lanza error tipado (no genérico)", () => {
    assert.throws(
      () => getConnector("woocommerce"),
      (e: unknown) => {
        assert.ok(e instanceof ConnectorNotImplementedError);
        assert.equal((e as ConnectorNotImplementedError).platform, "woocommerce");
        return true;
      },
    );
  });

  it("plataforma desconocida lanza tipado (no Error genérico)", () => {
    assert.throws(
      () => getConnector("magento" as never),
      (e: unknown) => e instanceof ConnectorNotImplementedError,
    );
  });

  it("isConnectorSupported solo cubre backends reales", () => {
    assert.equal(isConnectorSupported("medusa"), true);
    assert.equal(isConnectorSupported("shopify"), false);
    assert.equal(isConnectorSupported("woocommerce"), false);
    assert.deepEqual([...SUPPORTED_CONNECTORS], ["medusa"]);
  });
});

describe("credenciales extensibles", () => {
  it("string legacy normaliza a { token }", () => {
    assert.deepEqual(toCredentials("tok"), { token: "tok" });
  });

  it("objeto Woo conserva consumer_key + secret (2 secretos)", () => {
    const c = toCredentials({ token: "ck_123", secret: "cs_456" });
    assert.equal(c.token, "ck_123");
    assert.equal(c.secret, "cs_456");
  });
});

describe("markets genéricos (no RegionMap Medusa)", () => {
  it("roundtrip markets ↔ regions sin pérdida", () => {
    const markets = [
      { sourceId: "r1", name: "Perú", currency: "pen", countries: ["PE"] },
      { sourceId: "r2", name: "México", currency: "mxn", countries: ["MX"] },
    ];
    const regions = marketsToRegions(markets);
    assert.deepEqual(regions["r1"], { name: "Perú", currency: "pen", countries: ["PE"] });
    assert.deepEqual(regionsToMarkets(regions), markets);
  });

  it("medusaConnector expone auth/test/markets (interfaz genérica)", () => {
    assert.equal(typeof medusaConnector.listMarkets, "function");
    assert.equal(typeof medusaConnector.authenticate, "function");
    assert.equal(typeof medusaConnector.testConnection, "function");
  });
});

describe("sync rechaza sin backend antes de tocar DB", () => {
  it("syncStoreFromPlatform(shopify) → ConnectorNotImplementedError", async () => {
    const { syncStoreFromPlatform } = await import("@/lib/sync");
    await assert.rejects(
      syncStoreFromPlatform("shopify", "https://x", "v1", "tok"),
      (e: unknown) => e instanceof ConnectorNotImplementedError,
    );
  });

  it("ensureStore(woocommerce) → ConnectorNotImplementedError", async () => {
    const { ensureStore } = await import("@/lib/sync");
    await assert.rejects(
      ensureStore("https://x", "tok", "woocommerce"),
      (e: unknown) => e instanceof ConnectorNotImplementedError,
    );
  });
});

describe("reglas canónicas (medusa-agnósticas)", () => {
  it("isRealOrder excluye test/cancelada/pago fallido", () => {
    assert.equal(
      isRealOrder({ status: "completed", paymentStatus: "captured", isTest: false }),
      true,
    );
    assert.equal(
      isRealOrder({ status: "completed", paymentStatus: "captured", isTest: true }),
      false,
    );
    assert.equal(
      isRealOrder({ status: "canceled", paymentStatus: "captured", isTest: false }),
      false,
    );
  });

  it("groupTotalsByCurrency nunca mezcla monedas", () => {
    const t = groupTotalsByCurrency([
      { amount: 100, currency: "PEN" },
      { amount: 50, currency: "pen" },
      { amount: 10, currency: "MXN" },
    ]);
    assert.equal(t.length, 2);
    assert.equal(t[0].currency, "pen");
    assert.equal(t[0].ordersCount, 2);
  });
});
