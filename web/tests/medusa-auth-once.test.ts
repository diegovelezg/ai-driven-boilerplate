// Configura-una-vez Medusa v1: el token guardado debe ser api_token
// permanente, nunca JWT temporal (~15min → 401 recurrente).
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isJwtToken, medusaTokenKind, isMedusaAuthError } from "@/lib/medusa";

const ROOT = join(import.meta.dirname, "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("medusa token helpers", () => {
  it("distingue JWT temporal de api_token permanente", () => {
    assert.equal(isJwtToken("a.b.c"), true);
    assert.equal(isJwtToken("64hex".repeat(16)), false);
    assert.equal(medusaTokenKind(""), "empty");
    assert.equal(medusaTokenKind("a.b.c"), "jwt");
    assert.equal(medusaTokenKind("abc123"), "api_token");
  });

  it("detecta errores de auth para fail-fast", () => {
    assert.equal(isMedusaAuthError(new Error("Medusa 401: Unauthorized")), true);
    assert.equal(isMedusaAuthError(new Error("Medusa 403: Forbidden")), true);
    assert.equal(isMedusaAuthError(new Error("Medusa 429: Too Many Requests")), false);
    assert.equal(isMedusaAuthError(new Error("Medusa 500: boom")), false);
  });
});

describe("configura-una-vez v1", () => {
  it("settings no guarda JWT temporal en silencio (falla fuerte)", () => {
    const s = src("lib/settings-actions.ts");
    assert.ok(!s.includes("sigue JWT"), "fallback silencioso a JWT: causa 401 cada ~15min");
    assert.ok(s.includes("Nada se guardó"), "el fallo de provisioning debe decir que nada se guardó");
    assert.ok(s.includes("api_token permanente"), "el mensaje debe apuntar al api_token permanente");
  });

  it("sync no reintenta auth y exige api_token en v1", () => {
    const s = src("lib/sync.ts");
    assert.ok(s.includes("isSyncAuthError"), "falta detector local de 401/403 (barrera de conectores)");
    assert.ok(s.includes("Reconecta en Settings"), "el 401 debe llevar mensaje accionable");
    assert.ok(s.includes("isJwtTokenLocal"), "falta guard JWT→api_token en v1");
  });
});
