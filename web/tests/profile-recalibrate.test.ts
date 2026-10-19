// Vigilante de perfil (#6): scan determinista, cadencia y diff HITL.
// Corre con: npm test (node:test vía tsx). Solo lógica pura, sin BD ni LLM.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCadence,
  evaluateDrift,
  isProvisional,
  type StatsLike,
} from "@/lib/profile-recalibrate/scan";
import {
  applyDeltaToProfile,
  buildDeltas,
  collectRejectedKeys,
  isManualSlot,
  mergeDeltaDecision,
  mergeDeltaRevert,
  resolveProposalStatus,
  type ProfileDelta,
} from "@/lib/profile-recalibrate/diff";
import { profileSlotPatch, resolveManualSlots } from "@/lib/store-profile-defs";
import {
  appendRecalibrateLog,
  formatRecalibrateLine,
  parseRecalibrateLine,
} from "@/lib/profile-recalibrate/log";
import type { StoreProfile } from "@/lib/store-profile-defs";
import { dueStatusFor } from "@/lib/customer-data";

const stats = (over: Partial<StatsLike> = {}): StatsLike => ({
  customers: 80,
  buyers: 60,
  repeatRate: 0.4,
  ticketMedian: 4500,
  ticketCurrency: "pen",
  intervalMedian: 38,
  intervalCoverage: 0.61,
  topDomains: [{ domain: "cafe.pe", customers: 12 }],
  enrichedSample: [{ domain: "cafe.pe", industry: "alimentos" }],
  ...over,
});

const profile = (over: Partial<StoreProfile> = {}): StoreProfile => ({
  storeId: "s1",
  businessModel: "b2c",
  verticalDetected: "café de especialidad",
  taxonomyId: null,
  buyerType: "consumidor final",
  industry: null,
  catalogType: "consumible",
  repurchaseCycleDays: 60,
  churnMultiplier: 1.25,
  archetype: "b2c_consumible",
  archetypeSource: "auto",
  manualSlots: [],
  companyRequired: false,
  description: "Café de especialidad por suscripción",
  interpretationConfidence: "media",
  notes: null,
  ...over,
});

const AUTO = { archetypeSource: "auto" as const, ageDays: 40 };

describe("evaluateDrift (triggers)", () => {
  it("sin cambios no dispara nada", () => {
    assert.deepEqual(evaluateDrift(stats(), stats(), AUTO), []);
  });

  it("buyers x2 dispara buyers_ratio", () => {
    const t = evaluateDrift(stats({ buyers: 25 }), stats({ buyers: 60 }), AUTO);
    assert.ok(t.some((x) => x.kind === "buyers_ratio" && x.requiresProfiler));
  });

  it("intervalo 60→38 con cobertura 61% dispara interval_drift", () => {
    const t = evaluateDrift(
      stats({ intervalMedian: 60 }),
      stats({ intervalMedian: 38, intervalCoverage: 0.61 }),
      AUTO,
    );
    assert.ok(t.some((x) => x.kind === "interval_drift"));
  });

  it("intervalo con cobertura <20% no dispara", () => {
    const t = evaluateDrift(
      stats({ intervalMedian: 60 }),
      stats({ intervalMedian: 38, intervalCoverage: 0.1 }),
      AUTO,
    );
    assert.ok(!t.some((x) => x.kind === "interval_drift"));
  });

  it("ticket en otra moneda no dispara (nunca mezclar monedas)", () => {
    const t = evaluateDrift(
      stats({ ticketMedian: 4500, ticketCurrency: "pen" }),
      stats({ ticketMedian: 900, ticketCurrency: "mxn" }),
      AUTO,
    );
    assert.ok(!t.some((x) => x.kind === "ticket_band"));
  });

  it("ticket x1.6 en la misma moneda sí dispara", () => {
    const t = evaluateDrift(
      stats({ ticketMedian: 1000 }),
      stats({ ticketMedian: 1700 }),
      AUTO,
    );
    assert.ok(t.some((x) => x.kind === "ticket_band"));
  });

  it("cruzar 20 buyers dispara solo con perfil auto", () => {
    const prev = stats({ buyers: 0 });
    const curr = stats({ buyers: 25 });
    assert.ok(
      evaluateDrift(prev, curr, AUTO).some((x) => x.kind === "buyers_threshold"),
    );
    assert.ok(
      !evaluateDrift(prev, curr, {
        archetypeSource: "manual",
        ageDays: 40,
      }).some((x) => x.kind === "buyers_threshold"),
    );
  });

  it("perfil >90d solo avisa (no llama al set)", () => {
    const t = evaluateDrift(stats(), stats(), {
      archetypeSource: "auto",
      ageDays: 120,
    });
    assert.deepEqual(
      t.map((x) => [x.kind, x.requiresProfiler]),
      [["stale_profile", false]],
    );
  });

  it("manual siempre es trigger fuerte", () => {
    const t = evaluateDrift(stats(), stats(), AUTO, { manual: true });
    assert.ok(t.some((x) => x.kind === "manual" && x.requiresProfiler));
  });

  it("provisional: cruce de umbral con pocos buyers", () => {
    const t = evaluateDrift(stats({ buyers: 0 }), stats({ buyers: 25 }), AUTO);
    assert.equal(isProvisional(t, 25), true);
    assert.equal(isProvisional(t, 80), false);
  });
});

describe("checkCadence (silencio por defecto)", () => {
  const now = new Date("2026-10-17T00:00:00Z");
  it("propuesta pendiente → salta siempre", () => {
    const v = checkCadence({
      lastSnapshotAt: null,
      hasPendingProposal: true,
      newBuyers: 50,
      now,
      manual: true,
    });
    assert.equal(v.run, false);
  });

  it("snapshot <7d → salta, salvo manual", () => {
    const base = {
      lastSnapshotAt: "2026-10-12T00:00:00Z",
      hasPendingProposal: false,
      newBuyers: 50,
      now,
    };
    assert.equal(checkCadence(base).run, false);
    assert.equal(checkCadence({ ...base, manual: true }).run, true);
  });

  it("<10 compradores nuevos → salta (solo automático)", () => {
    const v = checkCadence({
      lastSnapshotAt: "2026-08-01T00:00:00Z",
      hasPendingProposal: false,
      newBuyers: 9,
      now,
    });
    assert.equal(v.run, false);
  });

  it("manual salta la muestra mínima: corre sin compradores nuevos", () => {
    const v = checkCadence({
      lastSnapshotAt: "2026-08-01T00:00:00Z",
      hasPendingProposal: false,
      newBuyers: 0,
      now,
      manual: true,
    });
    assert.equal(v.run, true);
  });

  it("≥7d y ≥10 nuevos → corre", () => {
    const v = checkCadence({
      lastSnapshotAt: "2026-10-09T00:00:00Z",
      hasPendingProposal: false,
      newBuyers: 10,
      now,
    });
    assert.equal(v.run, true);
  });
});

describe("buildDeltas (HITL slot por slot)", () => {
  const ctx = {
    intervalCoverage: 0.61,
    intervalMedian: 38,
    rejectedKeys: new Set<string>(),
  };

  it("aceptación 1: perfil 60d vs real 38d propone 60→38 y nada más", () => {
    const deltas = buildDeltas(
      profile(),
      {
        archetype: "b2c_consumible",
        cycleDays: 38,
        taxonomyId: null,
        buyerType: "consumidor final",
        evidence: [
          { slot: "cycle_days", value: "Intervalo medido 38d", confidence: "alta" },
        ],
      },
      ctx,
    );
    assert.deepEqual(
      deltas.map((d) => [d.slot, d.de, d.a]),
      [["repurchase_cycle_days", "60", "38"]],
    );
  });

  it("aceptación 3: ciclo fijado a mano se respeta", () => {
    const deltas = buildDeltas(
      profile({ manualSlots: ["repurchase_cycle_days"] }),
      {
        archetype: null,
        cycleDays: 38,
        taxonomyId: null,
        buyerType: null,
        evidence: [],
      },
      ctx,
    );
    assert.deepEqual(deltas, []);
  });

  it("arquetipo manual (archetypeSource) se respeta sin manualSlots", () => {
    const deltas = buildDeltas(
      profile({ archetypeSource: "manual" }),
      {
        archetype: "b2b_recurrente",
        cycleDays: null,
        taxonomyId: null,
        buyerType: null,
        evidence: [],
      },
      ctx,
    );
    assert.ok(!deltas.some((d) => d.slot === "archetype"));
  });

  it("ciclo sin cobertura ≥20% no se propone como número", () => {
    const deltas = buildDeltas(
      profile(),
      {
        archetype: null,
        cycleDays: 38,
        taxonomyId: null,
        buyerType: null,
        evidence: [],
      },
      { ...ctx, intervalCoverage: 0.1 },
    );
    assert.ok(!deltas.some((d) => d.slot === "repurchase_cycle_days"));
  });

  it("taxonomía desconocida se descarta; la conocida entra", () => {
    const bad = buildDeltas(
      profile(),
      {
        archetype: null,
        cycleDays: null,
        taxonomyId: "gid://shopify/TaxonomyCategory/zz-9",
        buyerType: null,
        evidence: [],
      },
      ctx,
    );
    assert.ok(!bad.some((d) => d.slot === "taxonomy_id"));
    const good = buildDeltas(
      profile(),
      {
        archetype: null,
        cycleDays: null,
        taxonomyId: "gid://shopify/TaxonomyCategory/ap",
        buyerType: null,
        evidence: [],
      },
      ctx,
    );
    assert.deepEqual(
      good.map((d) => [d.slot, d.de, d.a]),
      [["taxonomy_id", null, "gid://shopify/TaxonomyCategory/ap"]],
    );
  });

  it("taxonomía null sin evidencia NO propone borrar la vigente", () => {
    const deltas = buildDeltas(
      profile({ taxonomyId: "gid://shopify/TaxonomyCategory/ap" }),
      {
        archetype: null,
        cycleDays: null,
        taxonomyId: null,
        buyerType: null,
        evidence: [],
      },
      ctx,
    );
    assert.ok(!deltas.some((d) => d.slot === "taxonomy_id"));
  });

  it("taxonomía null CON evidencia del slot sí propone borrarla", () => {
    const deltas = buildDeltas(
      profile({ taxonomyId: "gid://shopify/TaxonomyCategory/ap" }),
      {
        archetype: null,
        cycleDays: null,
        taxonomyId: null,
        buyerType: null,
        evidence: [
          { slot: "taxonomy_id", value: "El rubro real ya no es alimentos.", confidence: "alta" },
        ],
      },
      ctx,
    );
    assert.deepEqual(
      deltas.map((d) => [d.slot, d.de, d.a]),
      [["taxonomy_id", "gid://shopify/TaxonomyCategory/ap", null]],
    );
  });

  it("delta rechazado hace <60d no se re-propone", () => {
    const deltas = buildDeltas(
      profile(),
      {
        archetype: null,
        cycleDays: 38,
        taxonomyId: null,
        buyerType: null,
        evidence: [],
      },
      { ...ctx, rejectedKeys: new Set(["repurchase_cycle_days:38"]) },
    );
    assert.deepEqual(deltas, []);
  });

  it("sin cambios no hay deltas", () => {
    const deltas = buildDeltas(
      profile(),
      {
        archetype: "b2c_consumible",
        cycleDays: 60,
        taxonomyId: null,
        buyerType: "consumidor final",
        evidence: [],
      },
      ctx,
    );
    assert.deepEqual(deltas, []);
  });
});

describe("recalibrate log (JSONL auditable)", () => {
  it("roundtrip: formatea y parsea el evento completo", () => {
    const line = formatRecalibrateLine({
      store_id: "s1",
      source: "script",
      dry_run: true,
      outcome: "proposal",
      reason: "Propuesta creada.",
      triggers: [{ kind: "buyers_threshold", detail: "0→25", requiresProfiler: true }],
      proposal_id: "p1",
      deltas: [{ slot: "buyer_type", de: "a", a: "b" }],
      duration_ms: 12,
    });
    const e = parseRecalibrateLine(line);
    assert.ok(e);
    assert.equal(e.store_id, "s1");
    assert.equal(e.outcome, "proposal");
    assert.equal(e.triggers.length, 1);
    assert.equal(e.deltas?.[0]?.slot, "buyer_type");
    assert.equal(e.dry_run, true);
    void appendRecalibrateLog;
  });

  it("parse rechaza líneas corruptas sin lanzar", () => {
    assert.equal(parseRecalibrateLine(""), null);
    assert.equal(parseRecalibrateLine("{no json"), null);
    assert.equal(parseRecalibrateLine('{"ts":"x"}'), null);
  });

  it("append escribe una línea parseable (archivo temporal)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "recal-")), "r.jsonl");
    appendRecalibrateLog(
      {
        store_id: "s9",
        source: "post-sync",
        dry_run: false,
        outcome: "skipped",
        reason: "Propuesta pendiente.",
        triggers: [],
      },
      file,
    );
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(parseRecalibrateLine(lines[0])?.outcome, "skipped");
  });
});

describe("applyDeltaToProfile (escritura HITL)", () => {
  const delta = (over: Partial<ProfileDelta> = {}): ProfileDelta => ({
    slot: "repurchase_cycle_days",
    de: "60",
    a: "38",
    evidencia: "Intervalo medido 38d",
    confianza: "alta",
    decision: "pending",
    ...over,
  });

  it("ciclo válido 60→38 se aplica", () => {
    const r = applyDeltaToProfile(profile(), delta());
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.profile.repurchaseCycleDays, 38);
  });

  it("ciclo inválido (0, 2000, texto) se rechaza", () => {
    for (const a of ["0", "2000", "abc"]) {
      const r = applyDeltaToProfile(profile(), delta({ a }));
      assert.equal(r.ok, false, a);
      if (!r.ok) assert.match(r.message, /Ciclo/);
    }
  });

  it("ciclo a null limpia el slot (vuelve a auto)", () => {
    const r = applyDeltaToProfile(profile(), delta({ a: null }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.profile.repurchaseCycleDays, null);
  });

  it("arquetipo válido se aplica; inválido se rechaza", () => {
    const ok = applyDeltaToProfile(
      profile(),
      delta({ slot: "archetype", de: "b2c_consumible", a: "b2b_recurrente" }),
    );
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.profile.archetype, "b2b_recurrente");
    const bad = applyDeltaToProfile(
      profile(),
      delta({ slot: "archetype", de: "b2c_consumible", a: "invento" }),
    );
    assert.equal(bad.ok, false);
  });

  it("slot fijado a mano no se puede aplicar (defensa en profundidad)", () => {
    const byList = applyDeltaToProfile(
      profile({ manualSlots: ["repurchase_cycle_days"] }),
      delta(),
    );
    assert.equal(byList.ok, false);
    const bySource = applyDeltaToProfile(
      profile({ archetypeSource: "manual" }),
      delta({ slot: "archetype", de: "b2c_consumible", a: "b2b_recurrente" }),
    );
    assert.equal(bySource.ok, false);
  });

  it("taxonomía conocida entra; desconocida se rechaza; null limpia", () => {
    assert.equal(
      applyDeltaToProfile(
        profile(),
        delta({ slot: "taxonomy_id", de: null, a: "gid://shopify/TaxonomyCategory/ap" }),
      ).ok,
      true,
    );
    assert.equal(
      applyDeltaToProfile(
        profile(),
        delta({ slot: "taxonomy_id", de: null, a: "gid://shopify/TaxonomyCategory/zz-9" }),
      ).ok,
      false,
    );
    const nul = applyDeltaToProfile(profile(), delta({ slot: "taxonomy_id", de: "x", a: null }));
    assert.equal(nul.ok, true);
    if (nul.ok) assert.equal(nul.profile.taxonomyId, null);
  });

  it("buyer_type largo se corta a 80 sin romper", () => {
    const r = applyDeltaToProfile(
      profile(),
      delta({ slot: "buyer_type", de: null, a: "x".repeat(200) }),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.profile.buyerType?.length, 80);
  });

  it("no muta el perfil original", () => {
    const p = profile();
    const r = applyDeltaToProfile(p, delta());
    assert.equal(r.ok, true);
    assert.equal(p.repurchaseCycleDays, 60);
  });
});

describe("aceptación 4: dueStatus antes/después del delta (measure-risk)", () => {
  it("ciclo 60→38 mueve al_dia→por_vencer y por_vencer→vencido hacia los datos", () => {
    const before = profile(); // ciclo declarado 60d, multiplicador 1.25
    const applied = applyDeltaToProfile(before, {
      slot: "repurchase_cycle_days",
      de: "60",
      a: "38",
      evidencia: "Intervalo medido 38d",
      confianza: "alta",
      decision: "pending",
    });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    const after = applied.profile;
    // Cliente sin mediana propia: manda el ciclo del tenant (jerarquía del motor).
    assert.equal(dueStatusFor(45, before.repurchaseCycleDays, before.churnMultiplier), "al_dia");
    assert.equal(dueStatusFor(45, after.repurchaseCycleDays, after.churnMultiplier), "por_vencer");
    assert.equal(dueStatusFor(50, before.repurchaseCycleDays, before.churnMultiplier), "al_dia");
    assert.equal(dueStatusFor(50, after.repurchaseCycleDays, after.churnMultiplier), "vencido");
    assert.equal(dueStatusFor(null, after.repurchaseCycleDays, after.churnMultiplier), null);
  });
});

describe("collectRejectedKeys (ventana desde la decisión)", () => {
  const now = new Date("2026-10-17T00:00:00Z");
  const rej = (over: Partial<ProfileDelta> = {}): ProfileDelta => ({
    slot: "repurchase_cycle_days",
    de: "60",
    a: "38",
    evidencia: "",
    confianza: "media",
    decision: "rejected",
    decidedAt: "2026-10-16T00:00:00Z",
    ...over,
  });

  it("propuesta vieja rechazada ayer sigue bloqueando", () => {
    const keys = collectRejectedKeys(
      [{ createdAt: "2026-01-01T00:00:00Z", deltas: [rej()] }],
      now,
    );
    assert.deepEqual([...keys], ["repurchase_cycle_days:38"]);
  });

  it("rechazo decidido hace >60d ya no bloquea", () => {
    const keys = collectRejectedKeys(
      [{ createdAt: "2026-01-01T00:00:00Z", deltas: [rej({ decidedAt: "2026-07-01T00:00:00Z" })] }],
      now,
    );
    assert.equal(keys.size, 0);
  });

  it("sin decidedAt (legado) se usa la fecha de la propuesta", () => {
    const keys = collectRejectedKeys(
      [{ createdAt: "2026-10-10T00:00:00Z", deltas: [rej({ decidedAt: undefined })] }],
      now,
    );
    assert.equal(keys.size, 1);
  });

  it("aceptados y pending no bloquean", () => {
    const keys = collectRejectedKeys(
      [{
        createdAt: "2026-10-10T00:00:00Z",
        deltas: [rej({ decision: "accepted" }), rej({ decision: "pending", a: "40" })],
      }],
      now,
    );
    assert.equal(keys.size, 0);
  });
});

describe("resolveManualSlots (protección de slots manuales)", () => {
  const base = {
    archetype: "b2c_consumible" as const,
    cycleDays: 45,
    taxonomyId: null,
    buyerType: null,
  };

  it("fuente manual protege archetype + slots con valor", () => {
    assert.deepEqual(
      resolveManualSlots({ ...base, archetypeSource: "manual", existing: null }),
      ["archetype", "repurchase_cycle_days"],
    );
  });

  it("sugerido conserva la protección del ciclo manual si no cambió", () => {
    const existing = profile({ manualSlots: ["repurchase_cycle_days"], repurchaseCycleDays: 45 });
    assert.deepEqual(
      resolveManualSlots({ ...base, archetypeSource: "sugerido", existing }),
      ["repurchase_cycle_days"],
    );
  });

  it("sugerido NO protege un ciclo que el set cambió de valor", () => {
    const existing = profile({ manualSlots: ["repurchase_cycle_days"], repurchaseCycleDays: 60 });
    assert.deepEqual(
      resolveManualSlots({ ...base, archetypeSource: "sugerido", existing }),
      [],
    );
  });
});

describe("profileSlotPatch (update por columna)", () => {
  it("mapea cada slot a su columna con el tipo correcto", () => {
    assert.deepEqual(profileSlotPatch("repurchase_cycle_days", "38"), { repurchase_cycle_days: 38 });
    assert.deepEqual(profileSlotPatch("repurchase_cycle_days", null), { repurchase_cycle_days: null });
    assert.deepEqual(profileSlotPatch("archetype", "b2b_recurrente"), { archetype: "b2b_recurrente" });
    assert.deepEqual(profileSlotPatch("taxonomy_id", null), { taxonomy_id: null });
    assert.deepEqual(profileSlotPatch("buyer_type", "pyme"), { buyer_type: "pyme" });
  });
});

describe("resolveProposalStatus", () => {
  const d = (slot: ProfileDelta["slot"], decision: ProfileDelta["decision"]): ProfileDelta => ({
    slot,
    de: null,
    a: "x",
    evidencia: "",
    confianza: "media",
    decision,
  });

  it("todo pending → pending_review", () => {
    assert.equal(
      resolveProposalStatus([d("buyer_type", "pending"), d("taxonomy_id", "pending")]),
      "pending_review",
    );
  });

  it("parcial (un aceptado, resto pending) → pending_review", () => {
    assert.equal(
      resolveProposalStatus([d("buyer_type", "accepted"), d("taxonomy_id", "pending")]),
      "pending_review",
    );
  });

  it("todo aceptado → approved; mixto con un aceptado → approved", () => {
    assert.equal(resolveProposalStatus([d("buyer_type", "accepted")]), "approved");
    assert.equal(
      resolveProposalStatus([d("buyer_type", "accepted"), d("taxonomy_id", "rejected")]),
      "approved",
    );
  });

  it("todo rechazado → rejected", () => {
    assert.equal(
      resolveProposalStatus([d("buyer_type", "rejected"), d("taxonomy_id", "rejected")]),
      "rejected",
    );
  });
});

describe("isManualSlot", () => {
  it("lista manual + compat con archetype_source", () => {
    assert.equal(isManualSlot(profile({ manualSlots: ["taxonomy_id"] }), "taxonomy_id"), true);
    assert.equal(isManualSlot(profile({ manualSlots: ["taxonomy_id"] }), "buyer_type"), false);
    assert.equal(isManualSlot(profile({ archetypeSource: "manual" }), "archetype"), true);
    assert.equal(isManualSlot(profile({ archetypeSource: "manual" }), "buyer_type"), false);
    assert.equal(isManualSlot(profile(), "archetype"), false);
  });
});

describe("mergeDeltaRevert (revert quirúrgico post-claim)", () => {
  const ds = (): ProfileDelta[] => [
    { slot: "repurchase_cycle_days", de: "60", a: "38", evidencia: "", confianza: "alta", decision: "accepted", decidedAt: "2026-10-17T00:00:00Z" },
    { slot: "buyer_type", de: null, a: "pyme", evidencia: "", confianza: "media", decision: "pending" },
  ];

  it("revierte solo mi slot y preserva la decisión posterior de otro", () => {
    // Otro slot se aceptó DESPUÉS de mi claim (la versión avanzó):
    const fresh = ds().map((d) =>
      d.slot === "buyer_type" ? { ...d, decision: "accepted" as const, decidedAt: "2026-10-17T00:01:00Z" } : d,
    );
    const m = mergeDeltaRevert(fresh, "repurchase_cycle_days");
    assert.ok(m);
    const mine = m.find((d) => d.slot === "repurchase_cycle_days");
    const other = m.find((d) => d.slot === "buyer_type");
    assert.equal(mine?.decision, "pending");
    assert.equal(mine?.decidedAt, null);
    assert.equal(other?.decision, "accepted");
    assert.equal(other?.decidedAt, "2026-10-17T00:01:00Z");
    // Con mi slot de nuevo pending, la propuesta se reabre:
    assert.equal(resolveProposalStatus(m), "pending_review");
  });

  it("null si mi slot ya está pending o no existe", () => {
    assert.equal(mergeDeltaRevert(ds(), "buyer_type"), null);
    assert.equal(mergeDeltaRevert(ds(), "archetype"), null);
  });

  it("no muta el arreglo original", () => {
    const fresh = ds();
    mergeDeltaRevert(fresh, "repurchase_cycle_days");
    assert.equal(fresh[0].decision, "accepted");
  });
});

describe("new_vertical simétrico (mismo universo)", () => {
  const enriched = (domain: string, industry: string | null) => ({ domain, industry });
  const top = (domain: string, customers = 10) => ({ domain, customers });

  it("industria nueva en el top-5 enriquecido dispara", () => {
    const t = evaluateDrift(
      stats({
        topDomains: [top("cafe.pe")],
        enrichedSample: [enriched("cafe.pe", "alimentos")],
      }),
      stats({
        topDomains: [top("cafe.pe"), top("hotel.pe")],
        enrichedSample: [enriched("cafe.pe", "alimentos"), enriched("hotel.pe", "hotelería")],
      }),
      AUTO,
    );
    assert.ok(t.some((x) => x.kind === "new_vertical" && x.requiresProfiler));
  });

  it("misma industria con otro dominio no dispara", () => {
    const t = evaluateDrift(
      stats({
        topDomains: [top("cafe.pe")],
        enrichedSample: [enriched("cafe.pe", "alimentos")],
      }),
      stats({
        topDomains: [top("pan.pe")],
        enrichedSample: [enriched("pan.pe", "alimentos")],
      }),
      AUTO,
    );
    assert.ok(!t.some((x) => x.kind === "new_vertical"));
  });

  it("dominio sin enriquecer no dispara solo (asimetría de muestreo)", () => {
    const t = evaluateDrift(
      stats({ topDomains: [top("cafe.pe")], enrichedSample: [] }),
      stats({
        topDomains: [top("cafe.pe"), top("nuevo.pe")],
        enrichedSample: [enriched("cafe.pe", "alimentos")],
      }),
      AUTO,
    );
    assert.ok(!t.some((x) => x.kind === "new_vertical"));
  });

  it("cambio de industria del mismo dominio dispara", () => {
    const t = evaluateDrift(
      stats({
        topDomains: [top("cafe.pe")],
        enrichedSample: [enriched("cafe.pe", "alimentos")],
      }),
      stats({
        topDomains: [top("cafe.pe")],
        enrichedSample: [enriched("cafe.pe", "hotelería")],
      }),
      AUTO,
    );
    assert.ok(t.some((x) => x.kind === "new_vertical"));
  });

  it("industria fuera del top-5 no dispara", () => {
    const t = evaluateDrift(
      stats({
        topDomains: [top("cafe.pe")],
        enrichedSample: [enriched("cafe.pe", "alimentos")],
      }),
      stats({
        topDomains: [top("cafe.pe"), top("a.pe"), top("b.pe"), top("c.pe"), top("d.pe")],
        enrichedSample: [
          enriched("cafe.pe", "alimentos"),
          enriched("lejos.pe", "minería"),
        ],
      }),
      AUTO,
    );
    assert.ok(!t.some((x) => x.kind === "new_vertical"));
  });
});

describe("mergeDeltaDecision (carrera HITL)", () => {
  const ds = (): ProfileDelta[] => [
    { slot: "buyer_type", de: null, a: "x", evidencia: "", confianza: "media", decision: "pending" },
    { slot: "taxonomy_id", de: null, a: "y", evidencia: "", confianza: "media", decision: "pending" },
  ];

  it("marca solo mi slot con fecha, preserva el resto", () => {
    const m = mergeDeltaDecision(ds(), "buyer_type", "accepted", "2026-10-17T00:00:00Z");
    assert.ok(m);
    assert.equal(m.find((d) => d.slot === "buyer_type")?.decision, "accepted");
    assert.equal(m.find((d) => d.slot === "buyer_type")?.decidedAt, "2026-10-17T00:00:00Z");
    assert.equal(m.find((d) => d.slot === "taxonomy_id")?.decision, "pending");
  });

  it("null si el slot ya fue decidido o no existe", () => {
    const decided = ds().map((d) =>
      d.slot === "buyer_type" ? { ...d, decision: "rejected" as const } : d,
    );
    assert.equal(mergeDeltaDecision(decided, "buyer_type", "accepted", "t"), null);
    assert.equal(mergeDeltaDecision(ds(), "archetype", "accepted", "t"), null);
  });

  it("no muta el arreglo original", () => {
    const fresh = ds();
    mergeDeltaDecision(fresh, "buyer_type", "accepted", "t");
    assert.ok(fresh.every((d) => d.decision === "pending"));
  });
});
