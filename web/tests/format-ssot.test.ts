// Guardián SSOT de formato numérico (UI + agentes).
// Regla: todo valor visible —incluidos los datos que se le pasan a los
// agentes (tools ADK, prompts de workers)— pasa por `@/lib/format`.
// Prohibido:
// - importar formatMoney/formatNumber/formatDecimal/formatPercent* desde `@/lib/canonical`
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
// Archivo de vendor: componente Calendar oficial de shadcn (react-day-picker).
// Su `.toLocaleString` formatea el nombre del mes (fecha, no número/moneda,
// fuera del alcance del SSOT numérico) y se conserva verbatim del registry
// para que `shadcn add --overwrite` siga aplicándose limpio.
const VENDOR_DATE_UI = new Set(["components/ui/calendar.tsx"]);

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
  it("nadie importa helpers de formato desde @/lib/canonical (ni dinámico)", () => {
    const bad: string[] = [];
    const reStatic = /import\s*\{[^}]*format(Money|Number|Decimal|Percent)[^}]*\}\s*from\s*["']@\/lib\/canonical["']/;
    const reDynamic =
      /\{\s*[^}]*format(Money|Number|Decimal|Percent)[^}]*\}\s*=\s*await\s*import\(\s*["']@\/lib\/canonical["']\s*\)/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (reStatic.test(src) || reDynamic.test(src)) bad.push(rel(f));
    }
    assert.deepEqual(bad, [], `importan formato desde canonical (usar @/lib/format): ${bad.join(", ")}`);
  });

  it("no hay toLocaleString fuera del SSOT", () => {
    const bad: string[] = [];
    for (const f of files) {
      const r = rel(f);
      if (r === SSOT || VENDOR_DATE_UI.has(r)) continue;
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
    const re = /(S\/|US\$|MX\$|COP\$|CLP\$|ARS\$|R\$|€|£)\s*(\$\{|"|'|`)/;
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
    // Cubre "dividir /100", "divide por 100", "divídelo entre 100" y menciones
    // "minor units …/100". El SSOT divide (lib/format.ts) y está excluido.
    const re = /div[ií]d\w*\s+(por|entre|\/)\s*100|minor units[^\n]{0,60}\/ ?100/;
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
      "revenue_by_type_display",
      "recovered_this_month_display",
      "recovered_30d_display",
      "total_spent_display",
      "revenue_display",
      "revenue_all_display",
      "revenue_30d_display",
      "unit_price_display",
      "total_display",
      "monetary_display",
      "avg_ticket_display",
      "ticket_esperado_display",
      "valor_esperado_display",
    ]) {
      assert.ok(src.includes(twin), `falta gemelo display ${twin} en retain-tools.ts`);
    }
    assert.ok(src.includes("DISPLAY_RULE"), "falta regla DISPLAY_RULE en retain-tools.ts");
    const agent = readFileSync(join(ROOT, "lib/adk/agents/customer-agent.ts"), "utf8");
    assert.ok(!agent.includes("minor units /100"), "el agente aún pide dividir minor units");
    assert.ok(agent.includes("*_display"), "el agente no instruye usar *_display verbatim");
  });

  it("META = solo la key elegida en settings (cero heurísticas)", () => {
    const ctx = readFileSync(join(ROOT, "lib/item-context.ts"), "utf8");
    // Sin derivación de otras keys: ni ventana, ni citado, ni detalles, ni aprobado.
    // (Substrings con contexto —no "ventana" suelto— para no chocar con
    // ventanaTipicaDias/ventanaMedianaDias legítimos en otros módulos.)
    for (const banned of ["rawItemContext", "PROSE_MIN", "clienteDijo", "aprobado", "detalles"]) {
      assert.ok(!ctx.includes(banned), `item-context.ts aún deriva '${banned}' de otras keys`);
    }
    assert.ok(!/[. ]ventana\b|ventana\s*:|dateStart|dateEnd/.test(ctx), "item-context.ts aún arma ventanas de metadata");
    assert.ok(ctx.includes("REGLA DURA"), "item-context.ts debe declarar la regla settings-only");
    // Enriquecido mínimo: título + cantidad + contenido de la key elegida.
    for (const f of ["contiene", "categoria"]) {
      assert.ok(ctx.includes(f), `item-context.ts debe exponer '${f}'`);
    }
    const judge = readFileSync(join(ROOT, "lib/contactability.ts"), "utf8");
    assert.ok(!judge.includes("clienteDijo"), "el juez aún recibe citado de otras keys");
    assert.ok(!judge.includes("dateStart"), "el juez aún recibe ventanas de metadata");
    const cw = readFileSync(join(ROOT, "lib/copywriter.ts"), "utf8");
    assert.ok(!cw.includes("splitVentana"), "el copywriter aún arma ventanas de metadata");
    assert.ok(!cw.includes("anyApproved"), "el copywriter aún usa aprobado de metadata");
    assert.ok(!/it\.(ventana|clienteDijo|aprobado|detalles)/.test(cw), "el brief aún vuelca metadata de otras keys");
  });

  it("el ritmo del cliente sale de compras reales (SSOT), no de metadata", () => {
    const cw = readFileSync(join(ROOT, "lib/copywriter.ts"), "utf8");
    assert.ok(cw.includes("gapMed"), "el copywriter no calcula ritmo propio de órdenes reales");
    assert.ok(cw.includes("Última compra"), "el brief no ancla en última compra real");
    const judge = readFileSync(join(ROOT, "lib/contactability.ts"), "utf8");
    assert.ok(judge.includes("comprasPrevias"), "el juez no recibe compras reales");
  });
});
