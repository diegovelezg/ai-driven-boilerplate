// Args del worker dedicado (issue #24): parsing puro.
// Corre con: npm test (node:test stdlib vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerArgs } from "@/lib/worker-args";

describe("parseWorkerArgs", () => {
  it("defaults: una pasada, 5000ms, todos los kinds, todas las tiendas", () => {
    assert.deepEqual(parseWorkerArgs([]), { once: false, pollMs: 5000, kinds: undefined, unknownKinds: [], store: undefined });
  });

  it("acepta --once", () => {
    assert.equal(parseWorkerArgs(["--once"]).once, true);
  });

  it("acepta --poll-ms con = y separado", () => {
    assert.equal(parseWorkerArgs(["--poll-ms=2000"]).pollMs, 2000);
    assert.equal(parseWorkerArgs(["--poll-ms", "2000"]).pollMs, 2000);
  });

  it("acepta --kinds con = y separado", () => {
    assert.deepEqual(parseWorkerArgs(["--kinds=sync,morning"]).kinds, ["sync", "morning"]);
    assert.deepEqual(parseWorkerArgs(["--kinds", "sync,morning"]).kinds, ["sync", "morning"]);
  });

  it("filtra kinds desconocidos y los reporta (no idle silencioso)", () => {
    const r = parseWorkerArgs(["--kinds=sync,foo"]);
    assert.deepEqual(r.kinds, ["sync"]);
    assert.deepEqual(r.unknownKinds, ["foo"]);
  });

  it("solo desconocidos → kinds vacío (el worker falla en vez de idle)", () => {
    const r = parseWorkerArgs(["--kinds=foo"]);
    assert.deepEqual(r.kinds, []);
    assert.deepEqual(r.unknownKinds, ["foo"]);
  });

  it("respeta WORKER_POLL_MS y sanea inválidos (<500 → 5000)", () => {
    assert.equal(parseWorkerArgs([], "7000").pollMs, 7000);
    assert.equal(parseWorkerArgs(["--poll-ms=100"]).pollMs, 5000);
    assert.equal(parseWorkerArgs(["--poll-ms=abc"]).pollMs, 5000);
  });

  it("acepta --store con = y separado", () => {
    assert.equal(parseWorkerArgs(["--store=abc-123"]).store, "abc-123");
    assert.equal(parseWorkerArgs(["--store", "abc-123"]).store, "abc-123");
    assert.equal(parseWorkerArgs([]).store, undefined);
  });
});
