// Extractor determinista de contactos del prospector (emails/tels/RRSS).
// Corre con: npm test (node:test vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractLeadContacts, firstWritableDir, pickLeadContact, sanitizeLeadContact } from "@/lib/retrieval";

describe("extractLeadContacts", () => {
  it("mailto + tel + RRSS por href", () => {
    const r = extractLeadContacts({
      text: "Somos una empresa. Visítanos.",
      hrefs: [
        "mailto:ventas@ejemplo.pe?subject=hola",
        "tel:+51999888777",
        "https://www.facebook.com/ejemplope",
        "https://instagram.com/ejemplo.pe",
        "/contacto",
      ],
    });
    assert.deepEqual(r.emails, ["ventas@ejemplo.pe"]);
    assert.ok(r.phones.some((p) => p.replace(/\D/g, "") === "51999888777"));
    assert.ok(r.socials.some((s) => s.network === "facebook"));
    assert.ok(r.socials.some((s) => s.network === "instagram"));
  });

  it("regex sobre texto del footer (email + fijo Lima + celular)", () => {
    const r = extractLeadContacts({
      text: "Escríbenos a contacto@negocio.com o llama al (01) 234-5678 / 987 654 321",
      hrefs: [],
    });
    assert.ok(r.emails.includes("contacto@negocio.com"));
    assert.ok(r.phones.length >= 2);
  });

  it("wa.me aporta teléfono y social whatsapp", () => {
    const r = extractLeadContacts({
      text: "hola",
      hrefs: ["https://wa.me/51987654321?text=hola"],
    });
    assert.ok(r.phones.some((p) => p.replace(/\D/g, "").includes("51987654321")));
    assert.ok(r.socials.some((s) => s.network === "whatsapp"));
  });

  it("dedupe + topes (3/3/6)", () => {
    const r = extractLeadContacts({
      text: "a@x.pe a@x.pe b@x.pe c@x.pe d@x.pe",
      hrefs: ["mailto:a@x.pe", "mailto:A@X.PE"],
    });
    assert.ok(r.emails.length <= 3);
    assert.equal(r.emails[0], "a@x.pe");
  });

  it("ignora basura (png, años sueltos)", () => {
    const r = extractLeadContacts({
      text: "logo@2x.png fundado en 2024, llámanos",
      hrefs: [],
    });
    assert.ok(!r.emails.includes("logo@2x.png"));
    // "2024" solo (4 dígitos) no debe ser teléfono
    assert.ok(!r.phones.some((p) => p.replace(/\D/g, "") === "2024"));
  });

  it("despega email con teléfono/TLD pegados", () => {
    const r = extractLeadContacts({
      text: "8357bela@belacasa.com.peventas llámanos",
      hrefs: [],
    });
    assert.ok(r.emails.includes("bela@belacasa.com.pe"), JSON.stringify(r.emails));
    assert.ok(!r.emails.some((e) => e.includes("peventas")));
  });

  it("descarta fechas, versiones y placeholders como teléfonos", () => {
    const r = extractLeadContacts({
      text: "v 3.22.0 - 17-06-2024 © 2014-2025 llama al 999999999 o al 997 278 915",
      hrefs: [],
    });
    assert.ok(!r.phones.some((p) => p.includes("2024") || p.includes("3.22")));
    assert.ok(!r.phones.some((p) => p.replace(/\D/g, "") === "999999999"));
    assert.ok(r.phones.some((p) => p.replace(/\D/g, "") === "997278915"));
  });

  it("descarta contadores pegados sin separadores que no son celulares", () => {
    const r = extractLeadContacts({
      text: "visitas 671001451 escríbenos al 944118710",
      hrefs: [],
    });
    assert.ok(!r.phones.some((p) => p.replace(/\D/g, "") === "671001451"));
    assert.ok(r.phones.some((p) => p.replace(/\D/g, "") === "944118710"));
  });

  it("tel: con espacios codificados no pega dígitos", () => {
    const r = extractLeadContacts({
      text: "",
      hrefs: ["tel:997%20278%20915"],
    });
    assert.deepEqual(r.phones, ["+997278915"]);
  });

  it("dedupe por últimos 9 dígitos (51 + número = mismo)", () => {
    const r = extractLeadContacts({
      text: "977 605 014",
      hrefs: ["https://wa.me/51977605014"],
    });
    assert.equal(r.phones.length, 1);
  });

  it("filtra RRSS basura (share/intent, raíz, posts /p/)", () => {
    const r = extractLeadContacts({
      text: "",
      hrefs: [
        "https://www.facebook.com/sharer/sharer.php?u=https://x.pe;src=sdkpreparse",
        "https://twitter.com/intent/tweet",
        "https://facebook.com/",
        "https://www.instagram.com/p/BaCr0mYgaSr/",
        "https://www.facebook.com/NegocioReal",
      ],
    });
    assert.ok(r.socials.some((s) => s.url.includes("NegocioReal")));
    assert.ok(!r.socials.some((s) => /sharer|intent/.test(s.url)));
    assert.ok(!r.socials.some((s) => s.url === "https://facebook.com/"));
    assert.ok(!r.socials.some((s) => s.url.includes("/p/")));
  });

  it("pickLeadContact prefiere email", () => {
    assert.equal(
      pickLeadContact({ emails: ["a@x.pe"], phones: ["+51 999"], socials: [] }),
      "a@x.pe",
    );
    assert.equal(
      pickLeadContact({ emails: [], phones: ["+51 999"], socials: [] }),
      "+51 999",
    );
    assert.equal(pickLeadContact({ emails: [], phones: [], socials: [] }), null);
  });

  it("firstWritableDir cae a tmp si .data no es escribible (EACCES en Docker)", () => {
    const eacces = (dir: string) => {
      if (dir.includes(".data")) throw new Error("EACCES: permission denied, mkdir '/app/.data'");
    };
    assert.equal(firstWritableDir(["/app/.data/crawlee", "/tmp/retain-crawlee"], eacces), "/tmp/retain-crawlee");
    assert.equal(firstWritableDir(["/app/.data/crawlee", "/tmp/retain-crawlee"], () => {}), "/app/.data/crawlee");
    // Sin ningún dir creable devuelve el último (Crawlee dará su error, no otro).
    assert.equal(
      firstWritableDir(["/app/.data/crawlee", "/tmp/retain-crawlee"], () => { throw new Error("EACCES"); }),
      "/tmp/retain-crawlee",
    );
  });

  it("sanitizeLeadContact descarta nombres de personas", () => {
    assert.equal(sanitizeLeadContact("Luis Cueva"), null);
    assert.equal(sanitizeLeadContact("CEO de Patitas"), null);
    assert.equal(sanitizeLeadContact("https://patitasdeamor.com.pe/"), null);
    assert.equal(sanitizeLeadContact("ong@patitasdeamor.com.pe"), "ong@patitasdeamor.com.pe");
    assert.equal(sanitizeLeadContact("  Admin@PatitasDeAmor.com.pe "), "admin@patitasdeamor.com.pe");
    assert.equal(sanitizeLeadContact("997 278 915"), "997 278 915");
    assert.equal(sanitizeLeadContact("+51 997 278 915"), "+51 997 278 915");
  });
});
