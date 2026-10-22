// Patrón anti-paginación/límite del agente (contrato).
// Corre con: npm test (node:test vía tsx, sin BD ni server-only).
// Estrategia: análisis estático del fuente (retain-tools/customer-agent
// arrastran server-only vía prospect/log y no se pueden importar en test)
// + unit tests de las funciones puras que el patrón usa (rankItems,
// formatMoney, scope). Si esto se rompe, el agente vuelve a mentir
// totales o a recibir miles de filas en el prompt.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rankItems } from "@/lib/finance";
import { formatMoney } from "@/lib/format";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p: string) => readFileSync(join(root, p), "utf-8");

const tools = () => src("lib/adk/tools/retain-tools.ts");
const agent = () => src("lib/adk/agents/customer-agent.ts");

describe("envelope obligatorio {items,total_count,returned_count,truncated}", () => {
  it("todas las tools de lista devuelven envelope", () => {
    const t = tools();
    for (const name of ["list_signals", "list_actions", "find_customer", "list_leads", "get_top_products", "get_product_movements", "get_product_buyers"]) {
      assert.match(t, new RegExp(`name:\\s*"${name}"`), `${name} existe`);
    }
    // Cada return con items debe llevar los 3 campos del envelope.
    const returns = [...t.matchAll(/return\s*\{[^}]*items[^}]*\}/g)].map((m) => m[0]);
    assert.ok(returns.length >= 5, `se esperan ≥5 returns con items, hay ${returns.length}`);
    for (const r of returns) {
      assert.match(r, /total_count/, `falta total_count en: ${r.slice(0, 80)}`);
      assert.match(r, /returned_count/, `falta returned_count en: ${r.slice(0, 80)}`);
      assert.match(r, /truncated/, `falta truncated en: ${r.slice(0, 80)}`);
    }
  });

  it("filter_customers devuelve solo conteo (las filas las muestra la vista)", () => {
    const t = tools();
    const i = t.indexOf('"filter_customers"');
    assert.ok(i >= 0);
    // Bloque de la tool: hasta la siguiente `const X = new FunctionTool`.
    const next = t.indexOf("\n  const ", i + 20);
    const block = t.slice(i, next > i ? next : i + 4000);
    assert.match(block, /count:/);
    assert.doesNotMatch(block, /items:/);
  });

  it("get_product_movements declara total_count null (historial abierto, no total inventado)", () => {
    const t = tools();
    const i = t.indexOf('"get_product_movements"');
    assert.ok(i >= 0);
    const block = t.slice(i, i + 12000);
    assert.match(block, /total_count:\s*null/);
  });

  it("get_product_buyers totaliza desde variable, no desde items.length", () => {
    const t = tools();
    const i = t.indexOf('"get_product_buyers"');
    assert.ok(i >= 0);
    const block = t.slice(i, i + 12000);
    assert.match(block, /total_count:\s*total[^.]/);
    assert.doesNotMatch(block, /total_count:\s*items\.length/);
  });
});

describe("límites acotados (el LLM nunca pide miles)", () => {
  it("todo limit de lista está acotado a máx 20 (ficha permite 30)", () => {
    const t = tools();
    // Ficha (get_customer_orders) pagina historial: cap 30 legítimo, fuera de la regla de listas.
    const listSchemas = [...t.matchAll(/name:\s*"(list_signals|list_actions|list_leads|get_top_products|get_product_movements|get_product_buyers)"[\s\S]{0,800}?limit:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\((\d+)\)/g)];
    assert.ok(listSchemas.length >= 4, `listas con limit esperadas ≥4, hay ${listSchemas.length}`);
    for (const m of listSchemas) assert.ok(Number(m[2]) <= 20, `limit max ${m[2]} > 20 en ${m[1]}`);
  });

  it("prohibido .limit(N) literal en código de tools (solo .limit(n) del parámetro)", () => {
    const t = tools().replace(/\/\/.*$/gm, "");
    for (const bad of [".limit(500", ".limit(200", ".limit(5000", ".limit(1000", ".limit(50", ".limit(20"]) {
      assert.doesNotMatch(t, new RegExp(bad.replace(/[().]/g, (c) => `\\${c}`)), `patrón prohibido ${bad}`);
    }
  });
});

describe("agregados paginados con CAP + flag (nunca .length de ventana)", () => {
  it("conteos exactos vía count head, no .length", () => {
    const t = tools();
    assert.match(t, /count:\s*"exact"/);
    assert.match(t, /head:\s*true/);
  });

  it("cada agregado pagina en lotes 1000 con CAP y truncated", () => {
    const t = tools();
    for (const name of ["get_store_summary", "get_recovery_stats", "get_top_products", "get_product_movements", "get_product_buyers"]) {
      const i = t.indexOf(`"${name}"`);
      assert.ok(i >= 0, `${name} existe`);
      const block = t.slice(i, i + 6000);
      assert.match(block, /PAGE\s*=\s*1000/, `${name}: pagina en lotes 1000`);
      assert.match(block, /CAP/, `${name}: tiene CAP`);
      assert.match(block, /truncated/, `${name}: expone truncated`);
    }
  });
});

describe("scope de mercado corto + NULL-comodín (nunca .in(miles de UUIDs))", () => {
  it("todas las lecturas del agente pasan por withMarket/applyScopeFilter", () => {
    const t = tools();
    const froms = [...t.matchAll(/\.from\("(customers|orders|churn_signals|proposed_actions)"\)/g)].length;
    const scoped = (t.match(/withMarket\(/g) ?? []).length;
    assert.ok(froms >= 8, `lecturas esperadas ≥8, hay ${froms}`);
    assert.ok(scoped >= 8, `withMarket esperado ≥8, hay ${scoped}`);
  });

  it("prohibido .in(customer_id, <ids>) directo en tools (solo vía effectiveScopeFilter o chunkIds)", () => {
    const t = tools();
    // Rama chunkeada (chunkIds → .in("customer_id", c) con 200) sí está
    // permitida: es el path seguro para scopes fallback grandes. Lo prohibido
    // es meter la lista completa (ids/idList/miles de UUIDs) en una sola URL.
    assert.doesNotMatch(t, /\.in\("customer_id",\s*(ids|idList)\b/);
    assert.doesNotMatch(t, /customer_id,\s*<miles/);
  });
});

describe("moneda intra-vista (nunca PEN+MXN)", () => {
  it("rankItems filtra por viewCurrency y agrupa case-insensitive", () => {
    const r = rankItems(
      [
        { currency: "pen", items_json: [{ title: "Canadá", quantity: 2, unit_price: 100 }] },
        { currency: "PEN", items_json: [{ title: "canadá ", quantity: 1, unit_price: 100 }] },
        { currency: "mxn", items_json: [{ title: "Canadá", quantity: 99, unit_price: 9999 }] },
      ],
      "PEN",
      5,
    );
    assert.equal(r.top.length, 1);
    assert.equal(r.top[0].quantity, 3);
    assert.equal(r.top[0].revenueMinor, 300);
    assert.equal(r.top[0].orders, 2);
  });

  it("bottom excluye al top", () => {
    const r = rankItems(
      [
        { currency: "pen", items_json: [{ title: "A", quantity: 10, unit_price: 100 }] },
        { currency: "pen", items_json: [{ title: "B", quantity: 1, unit_price: 10 }] },
      ],
      "pen",
      1,
    );
    assert.equal(r.top[0].title, "A");
    assert.equal(r.bottom[0].title, "B");
  });

  it("formatMoney divide minor units /100", () => {
    assert.match(formatMoney(36461777, "PEN"), /364[., ]?618/);
  });

  it("get_top_products devuelve view_currency + display SSOT verbatim", () => {
    const t = tools();
    const i = t.indexOf('"get_top_products"');
    const block = t.slice(i, i + 6000);
    assert.match(block, /view_currency/);
    assert.match(block, /revenue_display/);
    assert.match(block, /ya formateado/);
    assert.match(block, /isRealDbOrder/);
    assert.match(t, /verbatim/);
  });
});

describe("instrucción del agente declara el patrón", () => {
  it("N de M + truncated + ficha de productos + recupero≠ventas", () => {
    const a = agent();
    assert.match(a, /N de M/);
    assert.match(a, /truncated/);
    assert.match(a, /get_top_products/);
    assert.match(a, /RECUPERAR ≠ VENDER/);
    assert.match(a, /Si una tool no devuelve un dato/);
  });
});

describe("paginación estable (offset sin duplicados/ausentes)", () => {
  it("todo .range() va con .order() + tie-breaker id", () => {
    // Sin ORDER determinista, el offset de PostgREST duplica/omite filas
    // cuando hay empates en placed_at/created_at/as_of. El tie-breaker es
    // siempre la PK `id` (existe en todas las tablas del loop).
    const files = [
      "lib/adk/tools/retain-tools.ts",
      "lib/product-detail.ts",
      "lib/retention.ts",
      "lib/scout.ts",
      "lib/analyst.ts",
      "lib/mira.ts",
      "lib/dispatcher.ts",
      "lib/copywriter.ts",
      "lib/prospect.ts",
      "lib/customers-db.ts",
      "lib/customer-data.ts",
      "lib/duplicates.ts",
      "lib/store-profiles.ts",
      "lib/profiling/analyst.ts",
      "lib/enrich.ts",
      "lib/classify.ts",
      "lib/review-actions.ts",
      "lib/sync.ts",
    ];
    for (const f of files) {
      const body = src(f).replace(/\/\/.*$/gm, "");
      const ranges = (body.match(/\.range\(/g) ?? []).length;
      // Sin offset no hay inestabilidad que chequear (sync usa returning en
      // vez del re-read paginado desde KISS): solo sync está exento.
      if (ranges === 0) {
        assert.equal(f, "lib/sync.ts", `${f}: sin .range, ¿offset sin tie-breaker o allowlist pendiente?`);
        continue;
      }
      // Cada cadena con .range debe contener .order("id" en los 800 chars previos.
      const idxs: number[] = [];
      let at = body.indexOf(".range(");
      while (at >= 0) {
        idxs.push(at);
        at = body.indexOf(".range(", at + 1);
      }
      for (const i of idxs) {
        const window = body.slice(Math.max(0, i - 1200), i);
        assert.match(
          window,
          /\.order\(\s*"id"/,
          `${f}: .range sin tie-breaker .order("id") en la cadena (offset inestable)`,
        );
      }
    }
  });
});

describe("scope fallback por IDs chunkeado (nunca URI too long)", () => {
  it("markets expone chunkIds + isLargeIdScope + fetchIdChunks", () => {
    const m = src("lib/market-utils.ts");
    assert.match(m, /SCOPE_ID_CHUNK_SIZE\s*=\s*200/);
    assert.match(m, /export function chunkIds/);
    assert.match(m, /export function isLargeIdScope/);
    assert.match(m, /export async function fetchIdChunks/);
  });

  it("list_signals/list_actions usan rama chunkeada + mira pagina por chunk", () => {
    const t = tools();
    assert.match(t, /isLargeIdScope\(marketScope\)/);
    assert.match(t, /chunkIds\(/);
    const mira = src("lib/mira.ts");
    assert.match(mira, /isLargeIdScope\(scope\)/);
    assert.match(mira, /chunkIds\(/);
  });
});
