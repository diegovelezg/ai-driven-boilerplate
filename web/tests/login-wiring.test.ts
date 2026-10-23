// Wiring multi-tenant del login: el cableado `storeId → readConnections`.
// Si alguien rompe `signInAction:60` (pasa storeId) o `planLoginSync` (lo usa),
// este test falla en vez de volver silenciosamente al bug N-users=N-fulls.
// Corre con: npm test (node:test stdlib vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planLoginSync, type LoginPlanDeps } from "@/lib/login-plan";

const CONN = { platform: "medusa", medusaUrl: "https://a.tienda.com", medusaToken: "tok", medusaVersion: "v1" };

function deps(over: Partial<LoginPlanDeps> & { readConnectionsSeen?: unknown[] }): LoginPlanDeps {
  return {
    readConnections: async (sid) => {
      over.readConnectionsSeen?.push(sid);
      return { ...CONN };
    },
    resolveStoreId: async () => null,
    hasRunningRun: async () => false,
    getLastFinishedAt: async () => null,
    ensureStore: async () => null,
    supabaseConfigured: true,
    ...over,
  } as LoginPlanDeps;
}

describe("planLoginSync wiring", () => {
  it("rama explícita: readConnections recibe el storeId de la membresía", async () => {
    const seen: unknown[] = [];
    const plan = await planLoginSync("store-B", deps({ readConnectionsSeen: seen }));
    assert.deepEqual(seen, ["store-B"]);
    assert.equal(plan.probeStoreId, "store-B");
    assert.equal(plan.storeId, "store-B");
    assert.equal(plan.decision.sync, true);
  });

  it("rama legacy (null): readConnections sin args y resuelve por URL", async () => {
    const seen: unknown[] = [];
    const plan = await planLoginSync(null, deps({
      readConnectionsSeen: seen,
      resolveStoreId: async () => "store-A",
      getLastFinishedAt: async () => new Date().toISOString(),
    }));
    assert.deepEqual(seen, [undefined]);
    assert.equal(plan.probeStoreId, "store-A");
    // Throttle reciente → sin full, pero con tienda para el morning.
    assert.equal(plan.decision.sync, false);
    assert.equal(plan.decision.reason, "sync-reciente");
    assert.equal(plan.storeId, "store-A");
  });

  it("reconciliación: URL de otra tienda omite (anti split-brain)", async () => {
    const plan = await planLoginSync("store-B", deps({
      resolveStoreId: async () => "store-OTRA",
    }));
    assert.equal(plan.storeId, null);
    assert.match(plan.omitReason ?? "", /url-resuelve-a-otra-tienda/);
  });
});
