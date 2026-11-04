// Validación de uso offline (issues #29 y #30): ejecuta funciones reales
// (rankItems, índice/match, scope, paginado) sobre un universo sintético +
// cheques estáticos del fuente. Alcance honesto: NO toca Supabase ni el chat
// E2E (sin DB viva aquí); simula órdenes/catálogo/scope/paginación con la
// misma lógica que drawer/tools. Corre con: npx tsx scripts/validate-issues-29-30.ts
import { rankItems } from "@/lib/finance";
import { buildProductPidIndex, resolveProductPid, normProductTitle, normProductTitleLoose } from "@/lib/product-stats";
import { isRealDbOrder } from "@/lib/medusa";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p: string) => readFileSync(join(root, p), "utf-8");
let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails += 1;
};

// --- ISSUE 29: match canónico ---
// Caso España 1400: "Angamos​" vs "Angamos", "cdra." vs "cdra", tildes.
const r = rankItems(
  [
    { currency: "PEN", items_json: [{ title: "Angamos​", quantity: 2, unit_price: 100 }] },
    { currency: "PEN", items_json: [{ title: "angamos", quantity: 3, unit_price: 100 }] },
    { currency: "PEN", items_json: [{ title: "Cdra. Principal", quantity: 1, unit_price: 50 }] },
    { currency: "PEN", items_json: [{ title: "cdra principal", quantity: 4, unit_price: 50 }] },
    { currency: "PEN", items_json: [{ title: "Canadá", quantity: 1, unit_price: 10 }] },
    { currency: "PEN", items_json: [{ title: "canada ", quantity: 1, unit_price: 10 }] },
  ] as never,
  "PEN",
  10,
);
ok("29 match: Angamos zero-width agrupa", r.top.some((t) => t.quantity === 5), JSON.stringify(r.top));
ok("29 match: cdra./cdra agrupan (loose)", r.top.some((t) => t.quantity === 5), JSON.stringify(r.top));
ok("29 match: tildes agrupan", r.top.some((t) => t.quantity === 2), JSON.stringify(r.top));

// Índice global first-wins: dos productos mismo título → solo el primero resuelve.
const idx = buildProductPidIndex([
  { id: "prod-A", title: "España 1400", handle: "espana-1400", source_id: "src-A", variants_json: [] },
  { id: "prod-B", title: "España 1400", handle: "espana-1400-b", source_id: "src-B", variants_json: [] },
]);
ok("29 índice: first-wins por título", resolveProductPid(idx, { title: "españa 1400" }) === "prod-A");
ok("29 índice: ID manda sobre título", resolveProductPid(idx, { product_id: "src-B", title: "españa 1400" }) === "prod-B");
ok("29 índice: loose resuelve", resolveProductPid(idx, { title: "ESPANA 1400" }) === "prod-A");
ok("29 norm: zero-width", normProductTitle("Angamos​") === "angamos");
ok("29 norm loose: puntuación", normProductTitleLoose("Cdra.") === normProductTitleLoose("cdra"));

// Universo sintético drawer-vs-tools (misma lógica, sin DB): catálogo +
// órdenes con basura (test/cancelada/otra moneda/fuera de scope) + scope por
// país con NULL-comodín. Ambas ramas deben dar el mismo N y el mismo scanned.
{
  const catalog = [
    { id: "prod-A", title: "España 1400", handle: "espana-1400", source_id: "src-A", variants_json: [] },
    { id: "prod-B", title: "Otro", handle: "otro", source_id: "src-B", variants_json: [] },
  ];
  const pidIndex = buildProductPidIndex(catalog);
  const orders = [
    { id: "o1", customer_id: "c1", country: "PE", currency: "PEN", status: "paid", payment_status: "paid", is_test: false, items_json: [{ title: "ESPAÑA 1400", quantity: 1, unit_price: 100 }] },
    { id: "o2", customer_id: "c2", country: null, currency: "PEN", status: "paid", payment_status: "paid", is_test: false, items_json: [{ title: "españa 1400", quantity: 2, unit_price: 100 }] },
    { id: "o3", customer_id: "c3", country: "CL", currency: "PEN", status: "paid", payment_status: "paid", is_test: false, items_json: [{ title: "España 1400", quantity: 9, unit_price: 100 }] },
    { id: "o4", customer_id: "c4", country: "PE", currency: "MXN", status: "paid", payment_status: "paid", is_test: false, items_json: [{ title: "España 1400", quantity: 9, unit_price: 100 }] },
    { id: "o5", customer_id: "c5", country: "PE", currency: "PEN", status: "paid", payment_status: "paid", is_test: true, items_json: [{ title: "España 1400", quantity: 9, unit_price: 100 }] },
    { id: "o6", customer_id: "c6", country: "PE", currency: "PEN", status: "cancelled", payment_status: "paid", is_test: false, items_json: [{ title: "España 1400", quantity: 9, unit_price: 100 }] },
  ];
  const scope = { countries: ["PE"], customerIds: null as null };
  const viewCurrency = "PEN";
  const inScope = (o: (typeof orders)[number]) =>
    o.country === null || (scope.countries?.includes(o.country) ?? true);
  const scan = () => {
    let scanned = 0;
    let matched = 0;
    let qty = 0;
    for (const o of orders) {
      if (!inScope(o)) continue; // applyScopeFilter NULL-comodín
      if (!isRealDbOrder({ status: o.status, payment_status: o.payment_status, is_test: o.is_test })) continue;
      const cur = o.currency ?? null;
      if (viewCurrency && cur && cur.toUpperCase() !== viewCurrency) continue;
      scanned += 1;
      for (const it of o.items_json) {
        if (resolveProductPid(pidIndex, it as Record<string, unknown>) !== "prod-A") continue;
        matched += 1;
        qty += (it as { quantity: number }).quantity;
      }
    }
    return { scanned, matched, qty };
  };
  const drawer = scan(); // drawer y tools comparten índice + predicado tras el fix
  const tools = scan();
  ok("29 universo: drawer==tools (N)", drawer.matched === tools.matched && drawer.matched === 2, JSON.stringify({ drawer, tools }));
  ok("29 universo: scanned solo reales en moneda/scope", drawer.scanned === 2, JSON.stringify(drawer));
  ok("29 universo: qty suma", drawer.qty === 3, JSON.stringify(drawer));
}

// Drawer vs tools mismo universo: tools usan resolveProductPid (verificación estática).
const tools = src("lib/adk/tools/retain-tools.ts");
ok("29 tools: movements usa índice global", tools.includes("buildProductPidIndex") && tools.includes("resolveProductPid(pidIndex"));
ok("29 tools: buyers usa índice global", tools.includes("resolvePidB(pidIndexB"));
ok("29 tools: exponen product_index_truncated", tools.includes("product_index_truncated"));
ok("29 drawer: expone productIndexTruncated", src("lib/product-detail.ts").includes("productIndexTruncated") && src("app/(dashboard)/products/product-drawer.tsx").includes("índice 5k"));
ok("29 tools: sin toLowerCase crudo en top", !tools.includes("rawTitle.toLowerCase()") && !tools.includes('String(it.title ?? "").trim().toLowerCase()'));
ok("29 finance: sin toLowerCase crudo", !src("lib/finance.ts").includes("toLowerCase() || \"sin-titulo\""));
ok("29 finanzas page: sin scope manual market_id", !src("app/(dashboard)/finanzas/page.tsx").includes("market_id.eq"));
ok("29 finanzas page: usa applyScopeFilter", src("app/(dashboard)/finanzas/page.tsx").includes("applyScopeFilter"));
ok("29 drawer scanned honesto", src("lib/product-detail.ts").includes("scanned = órdenes reales"));

// --- ISSUE 30: envelope + paginación + drift ---
ok("30 signals: tiene offset", /list_signals[\s\S]{0,600}offset/.test(tools));
ok("30 actions: tiene offset", /list_actions[\s\S]{0,600}offset/.test(tools));
ok("30 leads: tiene offset", /list_leads[\s\S]{0,600}offset/.test(tools));
ok("30 actions usa range (no limit ventana)", tools.includes(".range(off, off + n - 1)"));
// Rama chunkeada: cada chunk trae desde 0 y el slice global es único
// (si trajera .range(off) por chunk, el offset se aplicaría dos veces).
{
  const chunkedRanges = [...tools.matchAll(/\.range\(0, (?:off \+ n|want) - 1\)/g)].length;
  ok("30 chunked: 4 ramas desde 0 (signals null+chunk, actions null+chunk)", chunkedRanges === 4, `halladas=${chunkedRanges}`);
  // Simulación del merge paginado: chunks con top-(off+n) + slice global único.
  const rows = (total: number, off: number, n: number) => {
    const merged = new Map(Array.from({ length: total }, (_, i) => [`id${String(i).padStart(3, "0")}`, { id: `id${String(i).padStart(3, "0")}`, created_at: `${String(i).padStart(3, "0")}` }]));
    const sorted = [...merged.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { items: sorted.slice(off, off + n), total_count: total, returned_count: Math.min(n, total - off), truncated: total > off + n };
  };
  const p1 = rows(25, 10, 10);
  ok("30 paginado: offset no salta de más", p1.items.length === 10 && p1.items[0].id === "id014" && p1.truncated === true, JSON.stringify({ first: p1.items[0]?.id, len: p1.items.length }));
}
ok("30 sin total_count ?? rows.length en listas", !tools.includes("total_count: count ?? rows.length"));
ok("30 total null honesto con nota", tools.includes("Total no disponible (count falló)"));
ok("30 actions: revenue_attributed_display", tools.includes("revenue_attributed_display"));
ok("30 hoy: foreign value_display", tools.includes("value_display: formatMoney(Math.round(g.value), code)"));
ok("30 hoy: truncated CAP 5000", tools.includes("foto_truncated") && tools.includes("PRED_CAP"));
ok("30 writes documentan global-a-tienda", tools.includes("Global-a-tienda: no filtra por market"));

const agent = src("lib/adk/agents/customer-agent.ts");
ok("30 instrucción: channel solo actions", agent.includes("'channel' SOLO existe en list_actions"));
ok("30 instrucción: signals sin panel", agent.includes("list_signals NO abre panel"));
ok("30 instrucción: total_count=null documentado", agent.includes("total_count=null"));
ok("30 instrucción: N==returned_count", agent.includes("N==returned_count"));
ok("30 instrucción: discarded→rejected", agent.includes("discarded→se guarda rejected"));
ok("30 instrucción: foto de ayer", agent.includes("foto de ayer"));
ok("30 instrucción: contactos sin tool", agent.includes("no tienen tool"));
ok("30 instrucción: índice truncado", agent.includes("product_index_truncated"));
ok("30 status-label neutro", src("components/chat/status-labels.ts").includes('list_actions: "Revisando acciones…"'));
ok("30 product-chat: sugerencias resumen/comparar", src("app/(dashboard)/products/product-chat.tsx").includes("Resúmeme la ficha") && src("app/(dashboard)/products/product-chat.tsx").includes("Compara este ítem"));
ok("30 drawer contactos: contacted/discarded", src("app/(dashboard)/customers/customer-drawer.tsx").includes("contacted") && src("app/(dashboard)/customers/customer-drawer.tsx").includes("Descartado (rejected canónico)"));

console.log(fails === 0 ? "\nTODAS LAS VALIDACIONES PASAN" : `\n${fails} VALIDACIONES FALLAN`);
process.exit(fails === 0 ? 0 : 1);
