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
    assert.equal(isJwtToken(""), false);
    assert.equal(isJwtToken("  "), false);
    assert.equal(isJwtToken(null), false);
    assert.equal(isJwtToken(undefined), false);
    assert.equal(medusaTokenKind(""), "empty");
    assert.equal(medusaTokenKind("a.b.c"), "jwt");
    assert.equal(medusaTokenKind("abc123"), "api_token");
  });

  it("detecta errores de auth para fail-fast (anclado al status)", () => {
    assert.equal(isMedusaAuthError(new Error("Medusa 401: Unauthorized")), true);
    assert.equal(isMedusaAuthError(new Error("Medusa 403: Forbidden")), true);
    assert.equal(isMedusaAuthError(new Error("Medusa 429: Too Many Requests")), false);
    assert.equal(isMedusaAuthError(new Error("Medusa 500: boom")), false);
    // 429/5xx con "unauthorized" en el body NO es auth: sí se reintenta.
    assert.equal(isMedusaAuthError(new Error("Medusa 429: Unauthorized quota")), false);
    assert.equal(isMedusaAuthError(new Error("Medusa 500: unauthorized upstream")), false);
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
    // El 401 nace en fase 1 (regions), no solo en el paginador: el hint debe
    // envolver fetchConnectorRegions.
    assert.ok(
      s.includes("fetchConnectorRegions") && s.includes("withAuthHint"),
      "el hint debe cubrir regions (primera llamada de red)",
    );
  });

  it("api_token va solo en x-header (Bearer con hex lo rompería)", () => {
    const s = src("lib/medusa.ts");
    assert.ok(s.includes("x-medusa-access-token"), "falta header de api_token");
    assert.ok(
      !s.includes('headers.Authorization = `Bearer ${token}`;\n    headers["x-medusa-access-token"]'),
      "doble header Bearer+x para api_token: el middleware puede validar Bearer primero como JWT y tumbar el provisioning",
    );
  });

  it("el toast de error no decapita el hint", () => {
    const s = src("components/background-status.tsx");
    assert.ok(s.includes("ERROR_DETAIL_MAX"), "el error debe usar cap mayor que SUMMARY_MAX=120");
  });

  it("toasts terminados idénticos se colapsan (no x3)", () => {
    const s = src("components/background-status.tsx");
    assert.ok(s.includes("seen"), "la cola debe dedupar terminados por (kind, status, error)");
  });

  it("settings usa storeId explícito (sin mezcla cross-tenant)", () => {
    const s = src("lib/settings-actions.ts");
    assert.ok(s.includes("formStoreId"), "los saves deben leer el hint storeId del form");
    assert.ok(
      s.includes("No se pudo verificar acceso a esta tienda"),
      "denyWithoutMembership debe ser fail-closed en mutaciones",
    );
    assert.ok(
      s.includes("revokeSecretAction(secret: RevocableSecret, storeIdArg?"),
      "revoke debe aceptar storeId explícito",
    );
    const page = src("app/(dashboard)/settings/page.tsx");
    assert.ok(page.includes("getMyActiveStore"), "settings debe resolver ?store= por membresía");
    const form = src("components/settings-form.tsx");
    assert.ok(form.includes('name="storeId"'), "los forms deben enviar storeId oculto");
  });
});
