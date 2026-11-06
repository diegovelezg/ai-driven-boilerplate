// Issue #16 Fase 0/3: matriz de compatibilidad de operaciones.
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  conflictMessage,
  conflictsWith,
  errorCodeMessage,
  findConflict,
  isCompatible,
  type ActiveOp,
} from "@/lib/operations";

const op = (kind: string, scopeId: string | null = null, label = kind): ActiveOp => ({
  kind,
  scopeKind: scopeId ? "signal" : "global",
  scopeId,
  label,
});

describe("matriz de compatibilidad", () => {
  it("cadena scout→strategist→copywriter mutuamente secuencial", () => {
    for (const a of ["scout", "strategist", "copywriter"]) {
      for (const b of ["scout", "strategist", "copywriter"]) {
        assert.equal(conflictsWith({ kind: a }, op(b)), true, `${a} vs ${b}`);
      }
    }
  });

  it("enrichment corre con copywriter (criterio Fase 3)", () => {
    assert.equal(isCompatible({ kind: "enrichment" }, [op("copywriter")]), true);
    assert.equal(isCompatible({ kind: "copywriter" }, [op("enrichment")]), true);
    assert.equal(isCompatible({ kind: "prospect" }, [op("copywriter")]), true);
  });

  it("copywriter_single solo bloquea su señal", () => {
    const other = { kind: "copywriter_single", scopeKind: "signal" as const, scopeId: "sig-2" };
    assert.equal(isCompatible(other, [op("copywriter_single", "sig-1")]), true);
    const same = { kind: "copywriter_single", scopeKind: "signal" as const, scopeId: "sig-1" };
    assert.equal(isCompatible(same, [op("copywriter_single", "sig-1")]), false);
  });

  it("single contra bulk y regenerate", () => {
    const single = { kind: "copywriter_single", scopeKind: "signal" as const, scopeId: "sig-1" };
    assert.equal(isCompatible(single, [op("copywriter")]), false);
    assert.equal(isCompatible(single, [op("regenerate")]), false);
    assert.equal(isCompatible(single, [op("scout"), op("enrichment")]), true);
  });

  it("sin duplicados del mismo worker pesado", () => {
    for (const k of ["dispatcher", "analyst", "prospect", "profiler", "enrichment", "regenerate"]) {
      assert.equal(isCompatible({ kind: k }, [op(k, null, k)]), false, `${k} vs ${k}`);
    }
  });

  it("enrich_single contra bulk y contra su mismo dominio", () => {
    const same = { kind: "enrich_single", scopeKind: "domain" as const, scopeId: "acme.com" };
    assert.equal(isCompatible(same, [op("enrichment")]), false);
    assert.equal(
      isCompatible(same, [{ kind: "enrich_single", scopeKind: "domain", scopeId: "acme.com", label: "x" }]),
      false,
    );
    const other = { kind: "enrich_single", scopeKind: "domain" as const, scopeId: "otro.com" };
    assert.equal(
      isCompatible(other, [{ kind: "enrich_single", scopeKind: "domain", scopeId: "acme.com", label: "x" }]),
      true,
    );
  });

  it("findConflict nombra el conflicto y el mensaje es humano", () => {
    const hit = findConflict({ kind: "strategist" }, [op("enrichment", null, "Enriquecimiento"), op("scout", null, "Scout")]);
    assert.equal(hit?.kind, "scout");
    assert.equal(conflictMessage(hit!), "En curso: Scout…");
    assert.equal(findConflict({ kind: "enrichment" }, [op("copywriter")]), null);
  });
});

describe("errorCodeMessage", () => {
  it("códigos en lenguaje humano, nunca crudos", () => {
    assert.equal(errorCodeMessage("judge_veto"), "Omitido por el juez");
    assert.equal(errorCodeMessage("busy"), "En curso");
    assert.equal(errorCodeMessage("llm_fail"), "Falló el modelo de lenguaje");
    assert.equal(errorCodeMessage("stale"), "Se interrumpió (proceso colgado)");
    assert.equal(errorCodeMessage("conflict"), "En curso");
  });
});
