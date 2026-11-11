// Vínculos explícitos agencia ↔ anunciante: validación + fusión con derivados.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  linkPairForOrder,
  mergeNetworkCounters,
  validateCompanyLinkPair,
} from "@/lib/company-links";

describe("company links", () => {
  it("rechaza par vacío o auto-vínculo", () => {
    assert.equal(validateCompanyLinkPair({ agencyCompanyId: "", advertiserCompanyId: "b" }).ok, false);
    assert.equal(validateCompanyLinkPair({ agencyCompanyId: "a", advertiserCompanyId: "a" }).ok, false);
    const good = validateCompanyLinkPair({ agencyCompanyId: " a ", advertiserCompanyId: "b" });
    assert.equal(good.ok, true);
  });

  it("OI anunciante+intermediaria asegura (agencia, anunciante)", () => {
    assert.deepEqual(
      linkPairForOrder({ advertiserCompanyId: "adv", billingCompanyId: "adv", agencyCompanyId: "ag" }),
      { agencyCompanyId: "ag", advertiserCompanyId: "adv" },
    );
  });

  it("directa y marca sin empresa no aseguran vínculo", () => {
    assert.equal(
      linkPairForOrder({ advertiserCompanyId: "a", billingCompanyId: "a", agencyCompanyId: "a" }),
      null,
    );
    assert.equal(
      linkPairForOrder({ advertiserCompanyId: null, billingCompanyId: "ag", agencyCompanyId: "ag" }),
      null,
    );
  });

  it("histórico advertiser<>billing asegura (billing, advertiser)", () => {
    assert.deepEqual(
      linkPairForOrder({ advertiserCompanyId: "adv", billingCompanyId: "ag", agencyCompanyId: null }),
      { agencyCompanyId: "ag", advertiserCompanyId: "adv" },
    );
  });

  it("merge: explícito sin OIs entra con ios=0; con OIs conserva conteo", () => {
    const merged = mergeNetworkCounters(
      [{ id: "a", ios: 3 }],
      new Map([["a", "oi" as const], ["b", "manual" as const]]),
    );
    const byId = new Map(merged.map((m) => [m.id, m]));
    assert.equal(byId.get("a")?.ios, 3);
    assert.equal(byId.get("a")?.explicit, true);
    assert.equal(byId.get("b")?.ios, 0);
    assert.equal(byId.get("b")?.explicit, true);
    assert.equal(byId.get("b")?.origin, "manual");
  });
});
