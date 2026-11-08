// Regresión del parpadeo: al dejar de escribir se veía el término anterior
// un instante ("ab"), filtraba y reaparecía lo tipeado ("abc").
// Causa: el sync committed!==initialValue revertía el input a la URL vieja
// durante la navegación pendiente. La URL solo manda si el usuario no está
// escribiendo otra cosa, y lo ya enviado no se reenvía.
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextQueryOnProp, searchSendDecision } from "@/components/filter-search";

describe("nextQueryOnProp", () => {
  it("sin cambio de URL no toca el input", () => {
    assert.equal(nextQueryOnProp("abc", "ab", "ab"), "abc");
  });

  it("en reposo adopta la URL nueva (Limpiar del padre, back/forward)", () => {
    assert.equal(nextQueryOnProp("abc", "abc", ""), "");
    assert.equal(nextQueryOnProp("", "", "xyz"), "xyz");
  });

  it("navegación pendiente: conserva lo tipeado (anti-parpadeo)", () => {
    // URL vieja "ab", usuario ya escribió "abc".
    assert.equal(nextQueryOnProp("abc", "ab", "ab"), "abc");
  });

  it("teclas durante el pending no se pierden al llegar la URL", () => {
    // Nav q=abc en vuelo (URL aún "ab"), usuario agregó "d".
    // Al completarse (URL "abc"), el input con "abcd" no se toca.
    assert.equal(nextQueryOnProp("abcd", "ab", "abc"), "abcd");
  });
});

describe("searchSendDecision", () => {
  it("input === URL: sincronizado, no enviar", () => {
    assert.equal(searchSendDecision("abc", "abc", "ab"), "synced");
  });

  it("ya enviado y URL vieja (pending): no reenviar", () => {
    assert.equal(searchSendDecision("abc", "ab", "abc"), "sent");
  });

  it("texto nuevo sin enviar: enviar tras debounce", () => {
    assert.equal(searchSendDecision("abcd", "ab", "abc"), "send");
    assert.equal(searchSendDecision("a", "", ""), "send");
  });
});

describe("secuencia del reporte (ab → abc)", () => {
  it("tipeo, envío, pending sin flash, llegada sin rebote", () => {
    // Estado inicial en reposo.
    let query = "ab";
    let prevProp = "ab";
    let url = "ab";
    let lastSent = "ab";

    // 1. Usuario escribe "c".
    query = "abc";
    assert.equal(nextQueryOnProp(query, prevProp, url), "abc", "no toca al tipear");
    assert.equal(searchSendDecision(query, url, lastSent), "send", "debounce debe enviar");

    // 2. Debounce dispara: se envía y empieza la navegación (URL aún vieja).
    lastSent = query; // onSearch("abc") → router.replace
    assert.equal(searchSendDecision(query, url, lastSent), "sent", "no reenvía en pending");
    assert.equal(nextQueryOnProp(query, prevProp, url), "abc", "NO flash al término anterior");

    // 3. Usuario sigue escribiendo durante el pending.
    query = "abcd";
    assert.equal(searchSendDecision(query, url, lastSent), "send", "la tecla nueva sí se envía");

    // 4. Llega la primera navegación (URL "abc") con "abcd" en el input.
    url = "abc";
    prevProp = "ab";
    query = nextQueryOnProp(query, prevProp, url);
    assert.equal(query, "abcd", "no pierde la tecla del pending");
  });
});
