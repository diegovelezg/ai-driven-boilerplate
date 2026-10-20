// Queue en Postgres (issue #24): helpers puros del worker/scheduler.
// Corre con: npm test (node:test stdlib vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loginSyncIdempotencyKey, morningIdempotencyKey, nextRetryDelayMs } from "@/lib/jobs";

describe("morningIdempotencyKey", () => {
  it("1 por día (Lima): mismo día = misma key", () => {
    const a = morningIdempotencyKey(new Date("2026-10-20T10:00:00Z"));
    const b = morningIdempotencyKey(new Date("2026-10-20T23:00:00Z"));
    assert.equal(a, b);
    assert.match(a, /^morning-\d{4}-\d{2}-\d{2}$/);
  });

  it("fecha Lima exacta (UTC-5, sin ICU-dependencia)", () => {
    // 10:00Z = 05:00 Lima del mismo día; 04:59Z aún es día anterior en Lima.
    assert.equal(morningIdempotencyKey(new Date("2026-10-20T10:00:00Z")), "morning-2026-10-20");
    assert.equal(morningIdempotencyKey(new Date("2026-10-20T04:59:00Z")), "morning-2026-10-19");
  });

  it("días distintos = keys distintas", () => {
    const a = morningIdempotencyKey(new Date("2026-10-20T10:00:00Z"));
    const b = morningIdempotencyKey(new Date("2026-10-21T10:00:00Z"));
    assert.notEqual(a, b);
  });
});

describe("loginSyncIdempotencyKey", () => {
  it("mismo bucket de 15min = misma key (dedupe logins concurrentes)", () => {
    const a = loginSyncIdempotencyKey(new Date("2026-10-20T10:00:00Z")); // 05:00 Lima
    const b = loginSyncIdempotencyKey(new Date("2026-10-20T10:07:00Z")); // 05:07 Lima
    assert.equal(a, b);
    assert.equal(a, "sync-login-2026-10-20-0500");
  });

  it("bucket distinto = key distinta", () => {
    const a = loginSyncIdempotencyKey(new Date("2026-10-20T10:07:00Z"));
    const b = loginSyncIdempotencyKey(new Date("2026-10-20T10:16:00Z")); // 05:16 Lima
    assert.notEqual(a, b);
    assert.equal(b, "sync-login-2026-10-20-0515");
  });
});

describe("nextRetryDelayMs", () => {
  it("backoff exponencial 1min, 2min, 4min", () => {
    assert.equal(nextRetryDelayMs(1), 60_000);
    assert.equal(nextRetryDelayMs(2), 120_000);
    assert.equal(nextRetryDelayMs(3), 240_000);
  });

  it("acota a 30min", () => {
    assert.equal(nextRetryDelayMs(10), 30 * 60_000);
  });
});
