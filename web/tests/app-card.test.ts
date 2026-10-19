// Guardián anti-caos visual de Cards.
// Corre con: npm test (node:test vía tsx).
// Regla SSOT: todo Card pasa por components/app-card.tsx (Header/Footer nativos,
// sin p-4/p-5/p-0/px-5 manuales ni footers border-t a mano).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SSOT = ["components/app-card.tsx", "components/ui/card.tsx"];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (/\.tsx$/.test(e)) out.push(p);
  }
  return out;
}

const files = tsxFiles(join(ROOT, "app")).concat(tsxFiles(join(ROOT, "components")));
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

describe("SSOT AppCard", () => {
  it("existe y exporta AppCard + AppCardState con tone/variant", () => {
    const src = readFileSync(join(ROOT, "components/app-card.tsx"), "utf8");
    assert.match(src, /export function AppCard/, "falta AppCard");
    assert.match(src, /export function AppCardState/, "falta AppCardState");
    for (const t of ["primary", "emerald", "amber", "sky"]) {
      assert.ok(src.includes(`"${t}"`) || src.includes(t), `falta tone ${t}`);
    }
    assert.ok(src.includes("hero") && src.includes("table"), "faltan variants hero/table");
    assert.ok(src.includes("CardHeader") && src.includes("CardFooter"), "debe usar Header/Footer nativos");
  });

  it("nadie importa el primitivo ui/card fuera del SSOT", () => {
    const bad = files
      .filter((f) => !SSOT.includes(rel(f)))
      .filter((f) => readFileSync(f, "utf8").includes("components/ui/card"));
    assert.deepEqual(bad.map(rel), [], `importan ui/card directo: ${bad.map(rel).join(", ")}`);
  });

  it("no hay <Card / <CardContent fuera del SSOT", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (SSOT.includes(rel(f))) continue;
      const src = readFileSync(f, "utf8");
      if (/<Card(Header|Title|Description|Action|Content|Footer)?[\s>]/.test(src)) bad.push(rel(f));
    }
    assert.deepEqual(bad, [], `usan <Card* manual: ${bad.join(", ")}`);
  });

  it("no hay paddings manuales p-4/p-5/p-0/px-5 en AppCards", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (SSOT.includes(rel(f))) continue;
      const src = readFileSync(f, "utf8");
      if (!src.includes("AppCard")) continue;
      const lines = src.split("\n");
      lines.forEach((ln, i) => {
        if (/AppCard/.test(ln) && /(["'\s])(p-[45]|p-0|px-5|pb-5)(["'\s])/.test(ln)) {
          bad.push(`${rel(f)}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(bad, [], `paddings manuales en AppCard: ${bad.join(", ")}`);
  });

  it("no hay footers a mano border-t + pt- en archivos con AppCard", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (SSOT.includes(rel(f))) continue;
      const src = readFileSync(f, "utf8");
      if (!src.includes("AppCard")) continue;
      const lines = src.split("\n");
      lines.forEach((ln, i) => {
        if (/border-t/.test(ln) && /pt-/.test(ln)) bad.push(`${rel(f)}:${i + 1}`);
      });
    }
    assert.deepEqual(bad, [], `footers manuales: ${bad.join(", ")} (usa prop footer)`);
  });
});
