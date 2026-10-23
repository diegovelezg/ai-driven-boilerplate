// Cobertura del log explícito de decisiones (fail-closed + wiring puro).
// Corre con: npm test (node:test stdlib vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildLoginRecord, recordLoginDecision } from "@/lib/login-decisions";
import type { LoginPlan } from "@/lib/login-plan";

const CONN = { platform: "medusa" as const, medusaUrl: "https://a.t.com", medusaToken: "tok", medusaVersion: "v1" };

function plan(over: Partial<LoginPlan>): LoginPlan {
  return {
    conn: CONN,
    probeStoreId: "store-B",
    running: false,
    lastSyncDoneAt: null,
    decision: { sync: true, reason: "ok" },
    storeId: "store-B",
    ...over,
  };
}

describe("buildLoginRecord", () => {
  it("split-brain → sync:false con el omitReason", () => {
    const r = buildLoginRecord(
      plan({ storeId: null, omitReason: "url-resuelve-a-otra-tienda store-OTRA" }),
      "store-B",
      "user-1",
    );
    assert.equal(r.sync, false);
    assert.match(String(r.reason), /url-resuelve-a-otra-tienda/);
    assert.equal(r.storeId, "store-B");
    assert.equal(r.userId, "user-1");
  });

  it("decisión sync:true pero storeId null (ensureStore falló) → sync:false", () => {
    const r = buildLoginRecord(
      plan({ storeId: null, probeStoreId: null, decision: { sync: true, reason: "ok" } }),
      null,
      "user-1",
    );
    assert.equal(r.sync, false);
    assert.equal(r.storeId, null);
  });

  it("normal con tienda → sync:true", () => {
    const r = buildLoginRecord(plan({}), "store-B", "user-1");
    assert.deepEqual(
      { sync: r.sync, reason: r.reason, storeId: r.storeId, userId: r.userId },
      { sync: true, reason: "ok", storeId: "store-B", userId: "user-1" },
    );
  });

  it("throttle/run-en-curso → sync:false con su reason", () => {
    const r = buildLoginRecord(
      plan({ running: true, decision: { sync: false, reason: "run-en-curso" } }),
      "store-B",
      null,
    );
    assert.equal(r.sync, false);
    assert.equal(r.reason, "run-en-curso");
    assert.equal(r.hasRunning, true);
  });
});

describe("recordLoginDecision fail-closed", () => {
  it("resuelve sin lanzar aunque el insert falle (DB sin migrar)", async () => {
    // Sin SUPABASE_* en env de test: isSupabaseConfigured()=false → no-op.
    await recordLoginDecision({
      storeId: "store-B",
      userId: null,
      sync: false,
      reason: "sync-reciente",
      hasRunning: false,
      lastSyncDoneAt: null,
    });
  });
});

describe("login-decisions acoplamiento service_role", () => {
  it("usa @/lib/supabase (service_role), nunca el client de request", async () => {
    const src = await readFile(new URL("../lib/login-decisions.ts", import.meta.url), "utf-8");
    assert.match(src, /["']@\/lib\/supabase["']/);
    assert.doesNotMatch(src, /supabase-server/);
  });
});
