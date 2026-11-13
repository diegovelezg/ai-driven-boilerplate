import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterLogLines, formatLogLine, parseLogLine, redactSecrets, serializeContext, shouldLog, trace } from "../lib/log";

describe("ssot log", () => {
  it("formato grep-friendly con nivel, scope y ctx", () => {
    const line = formatLogLine("profiler", "info", "pipeline synthesis", { arch: "b2b_recurrente" }, new Date("2026-01-01T00:00:00.000Z"));
    assert.equal(line, "[2026-01-01T00:00:00.000Z] [info] [profiler] pipeline synthesis arch=b2b_recurrente");
  });

  it("filtra por LOG_LEVEL", () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    try {
      assert.equal(shouldLog("api", "info"), false);
      assert.equal(shouldLog("api", "error"), true);
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
  });

  it("redacta secretos en mensaje y contexto", () => {
    assert.match(redactSecrets("Authorization: Bearer abc123.xyz"), /Bearer \[redacted\]/);
    assert.match(redactSecrets("llamo con sk-abcdefgh1234"), /sk-\[redacted\]/);
    const ctx = serializeContext({ token: "secreto", storeId: "s1" }, 2000);
    assert.match(ctx, /token=\[redacted\]/);
    assert.match(ctx, /storeId=s1/);
  });

  it("trunca mensajes gigantes", () => {
    const prev = process.env.LOG_MAX;
    process.env.LOG_MAX = "10";
    try {
      const line = formatLogLine("api", "info", "0123456789ABCDEF");
      assert.match(line, /truncado/);
    } finally {
      if (prev === undefined) delete process.env.LOG_MAX;
      else process.env.LOG_MAX = prev;
    }
  });

  it("parsea líneas SSOT y descarta otras", () => {
    const p = parseLogLine("[2026-01-01T00:00:00.000Z] [error] [brief] runBriefJob fail ms=12");
    assert.equal(p?.level, "error");
    assert.equal(p?.scope, "brief");
    assert.equal(parseLogLine("línea cualquiera"), null);
  });

  it("filtra por nivel mínimo, grep y since", () => {
    const lines = [
      "[2026-01-01T00:00:00.000Z] [info] [api] chat start",
      "[2026-06-01T00:00:00.000Z] [error] [brief] runBriefJob fail",
      "basura sin formato",
    ];
    assert.equal(filterLogLines(lines, { level: "error" }).length, 1);
    assert.equal(filterLogLines(lines, { grep: "chat" }).length, 1);
    assert.equal(filterLogLines(lines, { since: "2026-06-01" }).length, 1);
  });

  it("trace resuelve y relanza con el mismo valor/error", async () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "error"; // silencia el ok/info del trace
    try {
      assert.equal(await trace("scripts", "t-ok", async () => 42), 42);
      await assert.rejects(trace("scripts", "t-fail", async () => { throw new Error("boom"); }), /boom/);
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
  });
});
