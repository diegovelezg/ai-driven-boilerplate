// Guardia anti-deadcode Fase 2: el motor extirpado no debe resucitar.
// Falla si (a) vuelve a existir un archivo muerto, o (b) alguna sentencia de
// import/require viva referencia un módulo muerto. Los comentarios y docs no
// cuentan (pueden nombrar lo extirpado como registro HISTÓRICO).
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

// Archivos/módulos extirpados que no deben volver (rutas relativas a web/).
const DEAD_FILES = [
  "lib/morning-run.ts",
  "lib/retention-model.ts",
  "lib/retention.ts",
  "lib/scout.ts",
  "lib/strategist.ts",
  "lib/copywriter.ts",
  "lib/contactability.ts",
  "lib/prospect.ts",
  "lib/dispatcher.ts",
  "lib/analyst.ts",
  "lib/mira.ts",
  "lib/connectors",
  "lib/worker-args.ts",
  "lib/ai/decisions.ts",
  "lib/adk/tools/retain-tools.ts",
  "components/customer-badges.tsx",
  "components/product-badges.tsx",
  "components/filter-button.tsx",
  "components/inbox-tag.tsx",
  "lib/rhythm-describe.ts",
  "lib/action-trace.ts",
  "tests/rhythm-describe.test.ts",
  "tests/action-trace.test.ts",
  "tests/worker-args.test.ts",
];

// Fragmentos de ruta de módulo muerto: solo ofenden dentro de una sentencia
// de importación (import ... from "..." / require("...") / import("...")).
const DEAD_MODULE_FRAGMENTS = [
  "morning-run",
  "retention-model",
  "lib/retention",
  "lib/scout",
  "lib/strategist",
  "lib/copywriter",
  "lib/contactability",
  "lib/prospect",
  "lib/dispatcher",
  "lib/analyst",
  "lib/mira",
  "lib/connectors",
  "worker-args",
  "ai/decisions",
  "retain-tools",
  "customer-badges",
  "product-badges",
  "filter-button",
  "inbox-tag",
];

const IMPORT_RE = /(?:import\s[^;]*?from\s*['"]|require\s*\(\s*['"]|import\s*\(\s*['"])([^'"]+)['"]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

describe("deadcode Fase 2: el motor extirpado no resucita", () => {
  it("archivos muertos no existen", () => {
    const resurrected = DEAD_FILES.filter((f) => existsSync(join(ROOT, f)));
    assert.deepEqual(resurrected, [], `resucitaron: ${resurrected.join(", ")}`);
  });

  it("ningún import vivo referencia módulos muertos", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      if (file.endsWith("tests/deadcode.test.ts")) continue;
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(src)) !== null) {
        const spec = m[1];
        if (DEAD_MODULE_FRAGMENTS.some((frag) => spec.includes(frag))) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `imports muertos:\n${offenders.join("\n")}`);
  });
});
