import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWaMeUrl, normalizeForWaMe } from "@/lib/comms/whatsapp/wame";
import { resolveContact } from "@/lib/comms/contact";

describe("normalizeForWaMe", () => {
  it("respeta internacional con + y espacios", () => {
    assert.equal(normalizeForWaMe("+51 987 654 321", "PE"), "51987654321");
  });
  it("antepone país del cliente al nacional (quita 0 troncal)", () => {
    assert.equal(normalizeForWaMe("0987654321", "EC"), "593987654321");
  });
  it("null sin teléfono o sin país para nacional", () => {
    assert.equal(normalizeForWaMe(null, "PE"), null);
    assert.equal(normalizeForWaMe("987654321", null), null);
    assert.equal(normalizeForWaMe("abc", "PE"), null);
  });
});

describe("buildWaMeUrl", () => {
  it("arma click-to-chat con texto", () => {
    const url = buildWaMeUrl({ phone: "987654321", countryIso: "PE", text: "Hola Juan, te escribo" });
    assert.ok(url?.startsWith("https://wa.me/51987654321?text="));
    assert.ok(url?.includes(encodeURIComponent("Hola Juan, te escribo")));
  });
});

describe("resolveContact", () => {
  it("solo email → email-only", () => {
    assert.equal(resolveContact({ email: "a@b.com", phone: null, countryIso: "PE" }).capability, "email-only");
  });
  it("ambos → both", () => {
    assert.equal(
      resolveContact({ email: "a@b.com", phone: "987654321", countryIso: "PE" }).capability,
      "both",
    );
  });
  it("teléfono inservible → email-only (no se ofrece WhatsApp)", () => {
    assert.equal(resolveContact({ email: "a@b.com", phone: "??", countryIso: null }).capability, "email-only");
  });
  it("nada → none", () => {
    assert.equal(resolveContact({ email: "", phone: null, countryIso: null }).capability, "none");
  });
});
