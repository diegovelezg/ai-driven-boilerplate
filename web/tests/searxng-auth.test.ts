import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { searchSearxng, searxngHeaders } from "@/lib/retrieval";

describe("SearXNG Basic Auth (instancia compartida protegida)", () => {
  it("sin env no manda header (instancia abierta, como antes)", () => {
    const prev = process.env.SEARXNG_BASIC_AUTH;
    delete process.env.SEARXNG_BASIC_AUTH;
    try {
      assert.deepEqual(searxngHeaders(), {});
    } finally {
      if (prev !== undefined) process.env.SEARXNG_BASIC_AUTH = prev;
    }
  });

  it("con env manda Basic base64 de usuario:clave", () => {
    const prev = process.env.SEARXNG_BASIC_AUTH;
    process.env.SEARXNG_BASIC_AUTH = "shared:s3cr3t";
    try {
      assert.deepEqual(searxngHeaders(), {
        Authorization: `Basic ${Buffer.from("shared:s3cr3t", "utf8").toString("base64")}`,
      });
    } finally {
      if (prev !== undefined) process.env.SEARXNG_BASIC_AUTH = prev;
      else delete process.env.SEARXNG_BASIC_AUTH;
    }
  });

  it("searchSearxng propaga el header al fetch", async () => {
    const prev = process.env.SEARXNG_BASIC_AUTH;
    process.env.SEARXNG_BASIC_AUTH = "shared:s3cr3t";
    const origFetch = globalThis.fetch;
    let seen: Record<string, string> = {};
    (globalThis as Record<string, unknown>).fetch = (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
      seen = { ...(init?.headers ?? {}) };
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await searchSearxng("test", 1);
      assert.equal(seen.Authorization, `Basic ${Buffer.from("shared:s3cr3t", "utf8").toString("base64")}`);
    } finally {
      globalThis.fetch = origFetch;
      if (prev !== undefined) process.env.SEARXNG_BASIC_AUTH = prev;
      else delete process.env.SEARXNG_BASIC_AUTH;
    }
  });
});
