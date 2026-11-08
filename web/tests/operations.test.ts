// Matriz de compatibilidad de operaciones (Fase 2, real).
// `web/lib/operations.ts` implementa el lock kind+scope: mismo kind global
// choca siempre; scoped solo con mismo scopeKind+scopeId; distinto kind nunca.
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

describe("matriz de compatibilidad (Fase 2: lock kind+scope)", () => {
  it("mismo kind global conflicta", () => {
    assert.equal(conflictsWith({ kind: "import" }, op("import")), true);
    assert.equal(conflictsWith({ kind: "profile" }, op("profile")), true);
  });

  it("distinto kind nunca conflicta", () => {
    assert.equal(conflictsWith({ kind: "import" }, op("profile")), false);
  });

  it("scoped solo choca con mismo scope+id", () => {
    assert.equal(
      conflictsWith({ kind: "profile", scopeKind: "signal", scopeId: "s1" }, op("profile", "s1")),
      true,
    );
    assert.equal(
      conflictsWith({ kind: "profile", scopeKind: "signal", scopeId: "s1" }, op("profile", "s2")),
      false,
    );
  });

  it("isCompatible / findConflict coherentes", () => {
    assert.equal(isCompatible({ kind: "import" }, [op("profile")]), true);
    assert.equal(isCompatible({ kind: "import" }, [op("import")]), false);
    assert.equal(findConflict({ kind: "profile" }, [op("import")]), null);
    assert.notEqual(findConflict({ kind: "import" }, [op("import")]), null);
  });

  it("mensajes intactos", () => {
    assert.equal(conflictMessage(op("x", null, "Import")), "En curso: Import…");
    assert.equal(errorCodeMessage("busy"), "En curso");
  });
});
