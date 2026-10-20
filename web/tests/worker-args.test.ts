// Args del worker dedicado (issue #24): parsing puro.
// Corre con: npm test (node:test stdlib vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerArgs, parseWorkerSchedule, msUntilNextLimaRun } from "@/lib/worker-args";

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

describe("parseWorkerSchedule", () => {
  it("default: apagado, 06:00", () => {
    assert.deepEqual(parseWorkerSchedule({}), { enabled: false, hour: 6, minute: 0 });
  });

  it("acepta 1/true/on/yes", () => {
    for (const v of ["1", "true", "on", "yes", " True ", "YES", "ON"]) {
      assert.equal(parseWorkerSchedule({ WORKER_SCHEDULE: v }).enabled, true);
    }
    assert.equal(parseWorkerSchedule({ WORKER_SCHEDULE: "0" }).enabled, false);
  });

  it("hora/minuto válidos y sanea inválidos", () => {
    assert.deepEqual(parseWorkerSchedule({ WORKER_SCHEDULE: "1", WORKER_CRON_HOUR: "7", WORKER_CRON_MINUTE: "30" }), { enabled: true, hour: 7, minute: 30 });
    assert.deepEqual(parseWorkerSchedule({ WORKER_CRON_HOUR: "99", WORKER_CRON_MINUTE: "-1" }), { enabled: false, hour: 6, minute: 0 });
  });

  it("env vacío explícito cae al default (no a 00:00)", () => {
    assert.deepEqual(parseWorkerSchedule({ WORKER_CRON_HOUR: "", WORKER_CRON_MINUTE: " " }), { enabled: false, hour: 6, minute: 0 });
  });
});

describe("msUntilNextLimaRun", () => {
  it("06:00 Lima = 11:00 UTC (Lima UTC-5 fijo)", () => {
    // 10:00 UTC = 05:00 Lima → falta 1h para las 06:00 Lima.
    const now = Date.UTC(2026, 9, 20, 10, 0, 0);
    assert.equal(msUntilNextLimaRun(now, 6, 0), 3_600_000);
  });

  it("pasada la hora, programa mañana (24h - delta)", () => {
    // 12:00 UTC = 07:00 Lima → 23h para las próximas 06:00 Lima.
    const now = Date.UTC(2026, 9, 20, 12, 0, 0);
    assert.equal(msUntilNextLimaRun(now, 6, 0), 23 * 3_600_000);
  });

  it("instante exacto corre ahora (no espera 24h)", () => {
    // 11:00 UTC = 06:00 Lima exacto → 0ms.
    const now = Date.UTC(2026, 9, 20, 11, 0, 0);
    assert.equal(msUntilNextLimaRun(now, 6, 0), 0);
  });

  it("medianoche Lima: 23:59 Lima → 60s", () => {
    // 04:59 UTC = 23:59 Lima → 60s para las 00:00 Lima (05:00 UTC).
    const now = Date.UTC(2026, 9, 20, 4, 59, 0);
    assert.equal(msUntilNextLimaRun(now, 0, 0), 60_000);
  });

  it("minuto 59 respeta el minuto objetivo", () => {
    // 10:30 UTC = 05:30 Lima → 89min para las 06:59 Lima.
    const now = Date.UTC(2026, 9, 20, 10, 30, 0);
    assert.equal(msUntilNextLimaRun(now, 6, 59), 89 * 60_000);
  });
});
