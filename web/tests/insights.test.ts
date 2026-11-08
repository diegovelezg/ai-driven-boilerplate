// Muro de insights (issue #11): analizador determinista + arrobas + audiencia.
// Puro y testeable (tsx --test, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildBriefFacts,
  dedupeKey,
  isMine,
  mapAudience,
  MAX_POSTS_PER_DAY,
  resolveMentions,
} from "@/lib/insights";
import type { DashboardSnapshot } from "@/lib/dashboard";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const readRepo = (p: string) => readFileSync(join(ROOT, "..", p), "utf8");

function snap(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    currency: "PEN",
    comprometidoMesMinor: 0,
    firmadoMesMinor: 0,
    draftMesMinor: 0,
    byCurrency: {},
    ocupacion14d: { ratio: null, diasVendidos: 0, diasDisponibles: 0 },
    alAire: { ois: 0, pantallas: 0 },
    porCertificar: 0,
    renovacion30d: { conRelevo: 0, total: 0, ratio: null },
    alerts: [],
    huecos: [],
    counts: { ois: 0, screens: 0, truncated: false },
    truncated: false,
    ...over,
  };
}

describe("muro de insights (issue #11)", () => {
  it("silencio si sin cambios: snapshot vacío no emite hechos", () => {
    assert.deepEqual(buildBriefFacts(snap()), []);
  });

  it("tope 5/día y dedupe por (kind+scope)", () => {
    const alerts = Array.from({ length: 8 }, (_, i) => ({
      kind: "sin_om" as const,
      ioId: `io-${i % 4}`,
      ioNumber: `SM-2026-000${i % 4}`,
      brand: null,
      company: null,
      detail: "Sin OM.",
      startsAt: null,
      endsAt: null,
    }));
    const facts = buildBriefFacts(snap({ alerts }), 5);
    assert.ok(facts.length <= MAX_POSTS_PER_DAY, `tope: ${facts.length}`);
    const keys = facts.map((f) => dedupeKey(f.kind, f.scopeId));
    assert.equal(new Set(keys).size, keys.length, "dedupe por (kind+scope)");
  });

  it("no repite KPIs: los hechos traen deep-link accionable", () => {
    const facts = buildBriefFacts(
      snap({
        porCertificar: 3,
        ocupacion14d: { ratio: 0.42, diasVendidos: 42, diasDisponibles: 100 },
        huecos: [{ screenId: "s1", screenName: "Pantalla 1", diasLibres: 9 }],
      }),
    );
    assert.ok(facts.length >= 3);
    for (const f of facts) {
      assert.ok(f.link.startsWith("/orders") || f.link.startsWith("/screens"), `sin deep-link: ${f.link}`);
      assert.ok(f.detail.length > 0 && f.title.length > 0);
    }
  });

  it("arrobas: creador==editor o null → un solo @; difieren → ambos; >30d → creador", () => {
    assert.deepEqual(resolveMentions(null, null, null), []);
    assert.deepEqual(resolveMentions("a@x.pe", "a@x.pe", new Date().toISOString()), ["a@x.pe"]);
    assert.deepEqual(resolveMentions("a@x.pe", null, null), ["a@x.pe"]);
    assert.deepEqual(resolveMentions(null, "b@x.pe", null), ["b@x.pe"]);
    assert.deepEqual(resolveMentions("a@x.pe", "b@x.pe", new Date().toISOString()), ["a@x.pe", "b@x.pe"]);
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    assert.deepEqual(resolveMentions("a@x.pe", "b@x.pe", old), ["a@x.pe"]);
  });

  it("audiencia: emails → user_ids y Mis pendientes", () => {
    const members = [
      { user_id: "u1", email: "a@x.pe" },
      { user_id: "u2", email: "b@x.pe" },
    ];
    const aud = mapAudience(["A@x.pe"], members, ["seller"]);
    assert.deepEqual(aud.user_ids, ["u1"]);
    assert.equal(isMine(aud, { userId: "u1", email: null, role: null }), true);
    assert.equal(isMine(aud, { userId: "u9", email: "b@x.pe", role: null }), false);
    assert.equal(isMine({ roles: ["seller"] }, { userId: "u9", email: null, role: "seller" }), true);
    assert.equal(isMine({ roles: ["admin"] }, { userId: "u9", email: null, role: "seller" }), false);
  });

  it("migración crea sys_insights + sys_insight_reads con RLS por tenant", () => {
    const p = "supabase/migrations/20261209000000_brief_wall.sql";
    assert.ok(existsSync(join(ROOT, "..", p)), `falta migración ${p}`);
    const src = readRepo(p);
    assert.ok(src.includes("sys_insights"), "sin tabla sys_insights");
    assert.ok(src.includes("sys_insight_reads"), "sin tabla sys_insight_reads");
    assert.ok(src.includes("is_store_member"), "sin RLS por tenant");
  });

  it("narrador único brief_narrate declarado (sin swarm)", () => {
    const cfg = JSON.parse(read("config/llm_models.json")) as { processes: Record<string, unknown> };
    assert.ok(cfg.processes.brief_narrate, "falta process brief_narrate");
  });
});
