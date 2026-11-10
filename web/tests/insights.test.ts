// Muro de insights (issue #11): analizador determinista + arrobas + audiencia.
// Puro y testeable (tsx --test, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  audienceMentions,
  buildBriefFacts,
  buildDrawerHref,
  dedupeKey,
  describeContextShort,
  insightCta,
  isMine,
  mapAudience,
  MAX_POSTS_PER_DAY,
  resolveMentions,
  stripBodyLinks,
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
    cobranza: { invoicedMinor: 0, paidMinor: 0, pendingMinor: 0, overdueMinor: 0 },
    cobranzaByCurrency: {},
    deltas: { comprometido: null, cobranzaPendiente: null, alAireOis: null },
    prev: { comprometidoMinor: 0, cobranzaPendingMinor: 0, alAireOis: 0 },
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

  it("inbox es riesgos con acción: métricas de salud no emiten hechos (viven en el dashboard)", () => {
    const facts = buildBriefFacts(
      snap({
        porCertificar: 3,
        // Salud comercial (dashboard): ocupación, huecos y relevo 30d
        // nunca generan posts, aunque el snapshot los traiga.
        renovacion30d: { conRelevo: 1, total: 4, ratio: 0.25 },
        ocupacion14d: { ratio: 0.42, diasVendidos: 42, diasDisponibles: 100 },
        huecos: [{ screenId: "s1", screenName: "Pantalla 1", diasLibres: 9 }],
      }),
    );
    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, "por_certificar");
    assert.ok(facts[0].link.startsWith("/orders"), `sin deep-link: ${facts[0].link}`);
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

  it("taggeo visible: menciones @usuario y @rol, sin duplicados", () => {
    assert.deepEqual(audienceMentions({ emails: ["Ana@x.pe", "ana@x.pe"], roles: ["seller"] }), ["@ana", "@seller"]);
    assert.deepEqual(audienceMentions({ emails: [], roles: [] }), []);
    assert.deepEqual(audienceMentions({}), []);
  });

  it("contexto humano: solo cifras exactas, nunca estimadas", () => {
    assert.equal(
      describeContextShort({ company: "Alicorp", brand: "Tottus", screens: 3, amountMinor: 420000, currency: "PEN", startsAt: "2026-11-12", endsAt: "2026-11-30" }),
      "Cliente: Alicorp · Tottus · Pantallas: 3 · Monto: S/ 4.200 · Vigencia: 12/11 → 30/11",
    );
    assert.equal(describeContextShort({ company: null, brand: null, screens: 1, amountMinor: null, currency: null, startsAt: null, endsAt: null }), "Pantallas: 1");
    assert.equal(describeContextShort(null), null);
    assert.equal(describeContextShort({ company: null, brand: null, screens: null, amountMinor: 0, currency: "PEN", startsAt: null, endsAt: null }), null);
  });

  it("CTA con deep-link a drawer: orden abre ficha, global va a lista filtrada", () => {
    assert.deepEqual(insightCta({ kind: "sin_om", scopeKind: "order", scopeId: "io-1", links: ["/orders?order=io-1"] }), {
      label: "Registrar OM",
      href: "/orders?order=io-1",
      target: "drawer",
      param: "order",
      id: "io-1",
    });
    assert.deepEqual(insightCta({ kind: "material", scopeKind: "order", scopeId: "io-2", links: [] }), {
      label: "Aprobar material",
      href: "/orders?order=io-2",
      target: "drawer",
      param: "order",
      id: "io-2",
    });
    assert.deepEqual(insightCta({ kind: "sin_evidencia", scopeKind: "order", scopeId: "io-3", links: [] }), {
      label: "Subir evidencia",
      href: "/orders?order=io-3",
      target: "drawer",
      param: "order",
      id: "io-3",
    });
    assert.deepEqual(insightCta({ kind: "por_certificar", scopeKind: "global", scopeId: null, links: ["/orders"] }), {
      label: "Certificar",
      href: "/orders?stage=por_certificar",
      target: "page",
    });
    assert.deepEqual(insightCta({ kind: "huecos", scopeKind: "global", scopeId: null, links: ["/screens"] }), {
      label: "Cotizar huecos",
      href: "/screens",
      target: "page",
    });
    assert.deepEqual(insightCta({ kind: "ocupacion", scopeKind: "global", scopeId: null, links: ["/screens"] }), {
      label: "Ver inventario",
      href: "/screens",
      target: "page",
    });
    assert.deepEqual(insightCta({ kind: "x", scopeKind: "order", scopeId: null, links: ["https://evil"] }), {
      label: "Abrir",
      href: "/orders",
      target: "page",
    });
    assert.deepEqual(insightCta({ kind: "sin_om", scopeKind: null, scopeId: null, links: ["/orders?order=io-9"] }), {
      label: "Registrar OM",
      href: "/orders?order=io-9",
      target: "drawer",
      param: "order",
      id: "io-9",
    });
  });

  it("body sin rutas crudas: el deep-link vive en el CTA, no en el texto", () => {
    assert.equal(
      stripBodyLinks("Empezó hace 2d y sigue sin OM. Acción: registrar el OM en /orders?order=87c496a3-da68-4e94-8e9e-09f5775b92be."),
      "Empezó hace 2d y sigue sin OM. Acción: registrar el OM.",
    );
    assert.equal(stripBodyLinks("Ver https://ejemplo.pe/doc y /screens ya."), "Ver y ya.");
    assert.equal(stripBodyLinks("Relevo 30d · 2/5 (40%). Acción: ver relevo."), "Relevo 30d · 2/5 (40%). Acción: ver relevo.");
  });
  it("drawer href: misma página sin navegar, limpia otros drawers, preserva filtros", () => {
    assert.equal(buildDrawerHref("/inbox", "", "order", "io-1"), "/inbox?order=io-1");
    assert.equal(buildDrawerHref("/inbox", "q=om", "order", "io-1"), "/inbox?q=om&order=io-1");
    assert.equal(buildDrawerHref("/inbox", "q=om&order=old", "pantalla", "s-2"), "/inbox?q=om&pantalla=s-2");
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
