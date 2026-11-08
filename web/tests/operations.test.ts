// Issue #16 Fase 0/3: matriz de compatibilidad de operaciones (Fase 2).
// Sin pipeline programado: nada conflicta con nada.
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

describe("matriz de compatibilidad (Fase 2: sin pipeline)", () => {
  it("nada conflicta con nada", () => {
    for (const a of ["scout", "strategist", "copywriter", "prospect", "enrichment"]) {
      for (const b of ["scout", "strategist", "copywriter", "prospect"]) {
        assert.equal(conflictsWith({ kind: a }, op(b)), false, `${a} vs ${b}`);
      }
    }
  });

  it("isCompatible siempre true", () => {
    assert.equal(isCompatible({ kind: "copywriter" }, [op("copywriter")]), true);
  });

  it("findConflict siempre null", () => {
    assert.equal(findConflict({ kind: "scout" }, [op("scout")]), null);
  });

  it("mensajes intactos", () => {
    assert.equal(conflictMessage(op("x", null, "Copywriter")), "En curso: Copywriter…");
    assert.equal(errorCodeMessage("busy"), "En curso");
  });
});
