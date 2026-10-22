// Guardián SSOT de formato numérico (UI + agentes).
// Regla: todo valor visible —incluidos los datos que se le pasan a los
// agentes (tools ADK, prompts de workers)— pasa por `@/lib/format`.
// Prohibido:
// - importar formatMoney/formatNumber/formatDecimal/formatPercent* desde `@/lib/medusa`
//   (estático o dinámico)
// - `toLocaleString` o `new Intl.NumberFormat` fuera de `lib/format.ts`
// - símbolos de moneda a mano (`S/ ${`, `US$`…) fuera del SSOT
// - pedirle al LLM que divida minor units (`dividir /100`) en vez de
//   darle el gemelo `*_display` ya formateado
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SSOT = "lib/format.ts";

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(e)) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, "app"), /\.(ts|tsx)$/)
  .concat(walk(join(ROOT, "components"), /\.(ts|tsx)$/))
  .concat(walk(join(ROOT, "lib"), /\.(ts|tsx)$/));
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

describe("SSOT formato numérico", () => {
  it("nadie importa helpers de formato desde @/lib/medusa (ni dinámico)", () => {
    const bad: string[] = [];
    const reStatic = /import\s*\{[^}]*format(Money|Number|Decimal|Percent)[^}]*\}\s*from\s*["']@\/lib\/medusa["']/;
    const reDynamic =
      /\{\s*[^}]*format(Money|Number|Decimal|Percent)[^}]*\}\s*=\s*await\s*import\(\s*["']@\/lib\/medusa["']\s*\)/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (reStatic.test(src) || reDynamic.test(src)) bad.push(rel(f));
    }
    assert.deepEqual(bad, [], `importan formato desde medusa (usar @/lib/format): ${bad.join(", ")}`);
  });

  it("no hay toLocaleString fuera del SSOT", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (rel(f) === SSOT) continue;
      const src = readFileSync(f, "utf8");
      if (src.includes(".toLocaleString(")) bad.push(rel(f));
    }
    assert.deepEqual(bad, [], `usan .toLocaleString manual: ${bad.join(", ")}`);
  });

  it("no hay Intl.NumberFormat fuera del SSOT", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (rel(f) === SSOT) continue;
      const src = readFileSync(f, "utf8");
      if (src.includes("Intl.NumberFormat")) bad.push(rel(f));
    }
    assert.deepEqual(bad, [], `instancian Intl.NumberFormat manual: ${bad.join(", ")}`);
  });

  it("no hay símbolos de moneda a mano fuera del SSOT", () => {
    const bad: string[] = [];
    // `S/ ${`, `US$`, `MX$`… literales: la moneda sale de formatMoney.
    const re = /(S\/|US\$|MX\$|COP\$|CLP\$|ARS\$|R\$|€|£)\s*(\$\{|"|`)/;
    for (const f of files) {
      const r = rel(f);
      if (r === SSOT || r.startsWith("tests/")) continue;
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      lines.forEach((ln, i) => {
        if (re.test(ln)) bad.push(`${r}:${i + 1}`);
      });
    }
    assert.deepEqual(bad, [], `símbolos de moneda a mano (usar formatMoney): ${bad.join(", ")}`);
  });

  it("ningún tool/prompt le pide al LLM dividir minor units", () => {
    const bad: string[] = [];
    const re = /dividir \/100|minor units \/100/;
    for (const f of files) {
      const r = rel(f);
      if (r === SSOT || r.startsWith("tests/")) continue;
      const src = readFileSync(f, "utf8");
      // El SSOT divide (lib/format) y sus tests lo documentan; el resto
      // debe dar el *_display ya formateado, no la receta de división.
      if (r === "lib/format.ts") continue;
      if (re.test(src)) bad.push(r);
    }
    assert.deepEqual(bad, [], `piden al LLM dividir /100 (dar *_display SSOT): ${bad.join(", ")}`);
  });

  it("los tools del agente exponen gemelos *_display (SSOT en datos al LLM)", () => {
    const src = readFileSync(join(ROOT, "lib/adk/tools/retain-tools.ts"), "utf8");
    for (const twin of [
      "revenue_by_currency_display",
      "recovered_this_month_display",
      "total_spent_display",
      "revenue_display",
      "revenue_all_display",
      "unit_price_display",
      "total_display",
      "monetary_display",
      "avg_ticket_display",
    ]) {
      assert.ok(src.includes(twin), `falta gemelo display ${twin} en retain-tools.ts`);
    }
    assert.ok(src.includes("DISPLAY_RULE"), "falta regla DISPLAY_RULE en retain-tools.ts");
    const agent = readFileSync(join(ROOT, "lib/adk/agents/customer-agent.ts"), "utf8");
    assert.ok(!agent.includes("minor units /100"), "el agente aún pide dividir minor units");
    assert.ok(agent.includes("*_display"), "el agente no instruye usar *_display verbatim");
  });
});
