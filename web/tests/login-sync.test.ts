// Sync en cada inicio de sesión: la decisión pura que lo protege.
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
// Cubre solo lógica pura (sin BD): el wiring en auth-actions se verifica en runtime.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSyncOnLogin } from "@/lib/login-sync";

const MEDUSA_OK = { platform: "medusa" as const, medusaUrl: "http://x", medusaToken: "tok" };

describe("shouldSyncOnLogin", () => {
  it("dispara con Medusa + Supabase + sin run en curso", () => {
    assert.deepEqual(
      shouldSyncOnLogin(MEDUSA_OK, { supabaseConfigured: true, hasRunningRun: false }),
      { sync: true, reason: "ok" },
    );
  });

  it("omite Shopify (aún sin backend)", () => {
    assert.deepEqual(
      shouldSyncOnLogin(
        { platform: "shopify", medusaUrl: "", medusaToken: "" },
        { supabaseConfigured: true, hasRunningRun: false },
      ),
      { sync: false, reason: "shopify-sin-backend" },
    );
  });

  it("omite sin conexión Medusa", () => {
    assert.deepEqual(
      shouldSyncOnLogin(
        { platform: "medusa", medusaUrl: "", medusaToken: "" },
        { supabaseConfigured: true, hasRunningRun: false },
      ),
      { sync: false, reason: "sin-conexion" },
    );
  });

  it("omite sin Supabase", () => {
    assert.deepEqual(
      shouldSyncOnLogin(MEDUSA_OK, { supabaseConfigured: false, hasRunningRun: false }),
      { sync: false, reason: "sin-supabase" },
    );
  });

  it("omite con run en curso (no duplica sync)", () => {
    assert.deepEqual(
      shouldSyncOnLogin(MEDUSA_OK, { supabaseConfigured: true, hasRunningRun: true }),
      { sync: false, reason: "run-en-curso" },
    );
  });

  it("omite con sync done reciente (throttle 12h, cron dueño del full)", () => {
    assert.deepEqual(
      shouldSyncOnLogin(MEDUSA_OK, {
        supabaseConfigured: true,
        hasRunningRun: false,
        lastSyncDoneAt: new Date().toISOString(),
      }),
      { sync: false, reason: "sync-reciente" },
    );
  });

  it("omite con sync de hace 1h (5 users espaciados no hacen 5 fulls)", () => {
    assert.deepEqual(
      shouldSyncOnLogin(MEDUSA_OK, {
        supabaseConfigured: true,
        hasRunningRun: false,
        lastSyncDoneAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
      { sync: false, reason: "sync-reciente" },
    );
  });

  it("omite con timestamp corrupto (fail-closed, el cron cubre el full)", () => {
    assert.deepEqual(
      shouldSyncOnLogin(MEDUSA_OK, {
        supabaseConfigured: true,
        hasRunningRun: false,
        lastSyncDoneAt: "no-fecha",
      }),
      { sync: false, reason: "sync-reciente" },
    );
  });

  it("dispara con sync done viejo (>12h)", () => {
    assert.deepEqual(
      shouldSyncOnLogin(MEDUSA_OK, {
        supabaseConfigured: true,
        hasRunningRun: false,
        lastSyncDoneAt: new Date(Date.now() - 13 * 60 * 60_000).toISOString(),
      }),
      { sync: true, reason: "ok" },
    );
  });
});
