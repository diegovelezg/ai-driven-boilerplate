// Regresión issues #31-35 (totales honestos, counts, drift, match).
// Corre con: npm test (node:test vía tsx, sin BD ni server-only).
// Estrategia: análisis estático del fuente + units puros (rankItems),
// mismo patrón que agent-pattern.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rankItems } from "@/lib/finance";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p: string) => readFileSync(join(root, p), "utf-8");

const tools = () => src("lib/adk/tools/retain-tools.ts");
const agent = () => src("lib/adk/agents/customer-agent.ts");
const blockOf = (t: string, name: string, len = 9000) => {
  const i = t.indexOf(`"${name}"`);
  assert.ok(i >= 0, `${name} existe`);
  return t.slice(i, i + len);
};

describe("#31 totales honestos (store_summary, recovery_stats)", () => {
  it("summary: ningún total cae a ventana (offset) ni a 0 silencioso", () => {
    const b = blockOf(tools(), "get_store_summary");
    assert.doesNotMatch(b, /totalCustomers \?\? offset/);
    assert.doesNotMatch(b, /totalBuyers \?\? 0/);
    assert.doesNotMatch(b, /openSignals \?\? 0/);
    assert.doesNotMatch(b, /pendingActions \?\? 0/);
    assert.doesNotMatch(b, /leadsPending \?\? 0/);
    assert.match(b, /totals_note/);
  });

  it("recovery: total_measured null-aware con nota, CAP con note_truncated", () => {
    const b = blockOf(tools(), "get_recovery_stats");
    assert.doesNotMatch(b, /totalMeasured \?\? measured/);
    assert.match(b, /total_measured: totalMeasured \?\? null/);
    assert.match(b, /note_truncated/);
  });
});

describe("#32 sin scope (consultas directas a la tienda)", () => {
  it("hoy_snapshot no filtra por scope y usa moneda de la tienda", () => {
    const b = blockOf(tools(), "get_hoy_snapshot", 12000);
    assert.doesNotMatch(b, /scopeIds/);
    assert.doesNotMatch(b, /isLargeIdScope/);
    assert.doesNotMatch(b, /marketScope/);
    assert.match(b, /const viewCur = shopCurrency/);
  });

  it("get_top_products consulta directo, sin rama large-scope", () => {
    const b = blockOf(tools(), "get_top_products", 12000);
    assert.doesNotMatch(b, /isLargeIdScope/);
    assert.doesNotMatch(b, /withMarket\(/);
  });

  it("customers-db y product-detail consultan directo, sin scope", () => {
    assert.doesNotMatch(src("lib/customers-db.ts"), /isLargeIdScope/);
    assert.doesNotMatch(src("lib/product-detail.ts"), /largeScope/);
  });

  it("find_customer busca directo, sin filtro de scope en JS", () => {
    const b = blockOf(tools(), "find_customer", 12000);
    assert.doesNotMatch(b, /largeFind/);
    assert.doesNotMatch(b, /inFindScope/);
  });
});

describe("#33 counts silenciosos y CAPs con flag", () => {
  it("signals/actions consultan directo sin ramas large; conteos con null+nota", () => {
    const t = tools();
    assert.doesNotMatch(t, /isLargeIdScope/);
    assert.doesNotMatch(t, /chunkIds/);
    for (const name of ["list_signals", "list_actions"]) {
      const b = blockOf(t, name, 12000);
      assert.doesNotMatch(b, /countFailed/, `${name} sin rama large`);
      assert.match(b, /Total no disponible \(count falló\)/);
    }
    assert.doesNotMatch(blockOf(t, "get_inbox_summary", 6000), /return count \?\? 0/);
    assert.match(blockOf(t, "get_inbox_summary", 6000), /counts_note/);
  });

  it("filter_customers devuelve sobre de conteo honesto sin filas", () => {
    const b = blockOf(tools(), "filter_customers", 6000);
    assert.match(b, /total_count: res\.countFailed \? null : res\.totalCount/);
    assert.match(b, /predictionsTruncated/);
    assert.doesNotMatch(b, /items:/);
  });

  it("foto de predicciones expone truncado (CAP)", () => {
    assert.match(src("lib/customers-db.ts"), /getPredictionsPhoto/);
    assert.match(src("lib/customers-db.ts"), /truncated: true/);
  });

  it("runs y product_summary declaran ventana, no censo", () => {
    assert.match(blockOf(tools(), "get_runs_status", 4000), /Últimos 10 runs/);
    assert.match(blockOf(tools(), "get_product_summary", 5000), /note_truncated/);
  });
});

describe("#34 instrucción == router == UI", () => {
  it("la instrucción describe filter_customers como conteo + Customers", () => {
    const a = agent();
    assert.match(a, /filter_customers devuelve SOLO conteo \(sin filas\) y filtra la tabla de Customers/);
    assert.doesNotMatch(a, /actions\/leads\/filter_customers se muestran como Review/);
  });

  it("ARTIFACT_TOOLS = types.ts = dock (Review vs Customers)", () => {
    const route = src("app/api/chat/route.ts");
    assert.match(route, /const ARTIFACT_TOOLS = \["list_actions", "list_leads", "filter_customers"\]/);
    const types = src("components/chat/types.ts");
    assert.match(types, /coincide con ARTIFACT_TOOLS/);
    assert.doesNotMatch(types, /list_signals/);
    assert.doesNotMatch(types, /get_store_summary/);
    const dock = src("components/chat/chat-dock.tsx");
    for (const axis of ["ventana", "banda", "elegibilidad", "decil"]) {
      assert.match(dock, new RegExp(`f\\.${axis}`), `dock propaga ${axis}`);
    }
  });

  it("el refresh post-approve preserva limit y offset", () => {
    const route = src("app/api/chat/route.ts");
    assert.match(route, /offset\?: number/);
    assert.match(route, /\.range\(off, off \+ n - 1\)/);
  });
});

describe("#35 match canónico sin toLowerCase suelto", () => {
  it("finance/brain/detail no usan toLowerCase crudo sobre títulos", () => {
    // Patrones prohibidos exactos (issue #35): fallback crudo sobre .title.
    // (Otros toLowerCase sobre currency/IDs/email son legítimos y viven en
    // product-stats o fuera de títulos.)
    assert.doesNotMatch(src("lib/finance.ts"), /\.title\.toLowerCase\(\)/);
    assert.doesNotMatch(src("lib/brain.ts"), /it\.title \?\? ""\)\)/);
    assert.doesNotMatch(src("lib/product-detail.ts"), /normProductTitle\(String\(it\.title \?\? ""\)\) === normTitle;/);
  });

  it("tools (movements/buyers) y enrich tampoco usan toLowerCase crudo sobre títulos", () => {
    const t = tools();
    // Fallbacks exact-only eliminados: ahora exacto+loose sobre title y product_title.
    assert.doesNotMatch(t, /if \(!indexed\) return normProductTitle\(String\(it\.title/);
    assert.doesNotMatch(t, /if \(!indexedB\) return normTB\(String\(it\.title/);
    assert.match(t, /normTitleLoose/);
    assert.match(t, /normTitleLooseB/);
    assert.match(t, /normProductTitleLoose\(String\(it\.product_title/);
    // enrich: guard de identidad con normalización canónica.
    const enrich = src("lib/enrich.ts");
    assert.doesNotMatch(enrich, /r\.title\.toLowerCase\(\)/);
    assert.doesNotMatch(enrich, /r\.text\.toLowerCase\(\)/);
    assert.match(enrich, /normProductTitle\(r\.title\)/);
  });

  it("títulos vacíos/puntuación caen al mismo bucket sin-titulo", () => {
    const r = rankItems(
      [
        { currency: "PEN", items_json: [{ title: "", quantity: 1, unit_price: 100 }] },
        { currency: "PEN", items_json: [{ title: "…", quantity: 2, unit_price: 100 }] },
        { currency: "PEN", items_json: [{ title: "Cdra.", quantity: 1, unit_price: 50 }] },
        { currency: "PEN", items_json: [{ title: "cdra", quantity: 1, unit_price: 50 }] },
      ],
      "PEN",
      10,
    );
    const keys = r.top.map((t) => t.title);
    assert.ok(keys.includes("Sin título"), `bucket sin-titulo presente: ${keys}`);
    const cdra = r.top.filter((t) => t.title.toLowerCase().includes("cdra"));
    assert.equal(cdra.length, 1);
    assert.equal(cdra[0].quantity, 2);
  });
});
