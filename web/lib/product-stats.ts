// Ventas por producto y moneda (determinista, sin LLM). El sync lo recalcula
// por tenant desde orders reales; la UI y el futuro sub-engine solo leen.
import { getSupabase } from "@/lib/supabase";
import { isRealDbOrder } from "@/lib/medusa";
import { createLogger } from "@/lib/log";

const log = createLogger("product-stats");

const DAY_MS = 86_400_000;

/** Normaliza títulos para matchear items vendidos ↔ catálogo.
 *  Quita zero-width spaces (Medusa los trae: "Angamos\u200b"), minúsculas,
 *  colapsa espacios. Misma fn para sync, copywriter y tools. */
export function normProductTitle(t: string): string {
  return t
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export interface ProductStatsSummary {
  rows: number;
  matchedProducts: number;
  unmatchedTitles: number;
  /** Top no-matcheados por revenue (para afinar norm, no para UI). */
  topUnmatched: Array<{ title: string; revenue: number; currency: string }>;
}

/** Recalcula product_stats del tenant. Upsert-only por (product_id, currency). */
export async function computeProductStats(storeId: string): Promise<ProductStatsSummary> {
  const db = getSupabase();
  const now = Date.now();

  const { data: prods, error: pErr } = await db
    .from("products")
    .select("id,title")
    .eq("store_id", storeId)
    .limit(5000);
  if (pErr) throw new Error(`Products read: ${pErr.message}`);
  const productIdByTitle = new Map<string, string>();
  for (const p of (prods ?? []) as Array<Record<string, unknown>>) {
    const k = normProductTitle(String(p.title ?? ""));
    if (k && !productIdByTitle.has(k)) productIdByTitle.set(k, String(p.id));
  }

  interface Agg {
    qtyAll: number; qty30: number; qty90: number;
    revAll: number; rev30: number;
    buyers: Set<string>; lastSold: string | null;
  }
  const agg = new Map<string, Agg>(); // key = normTitle + "|" + currency
  const keyOf = (t: string, c: string) => `${t}|${c}`;
  const get = (k: string): Agg => {
    let a = agg.get(k);
    if (!a) {
      a = { qtyAll: 0, qty30: 0, qty90: 0, revAll: 0, rev30: 0, buyers: new Set(), lastSold: null };
      agg.set(k, a);
    }
    return a;
  };

  for (let off = 0; ; off += 1000) {
    const { data, error } = await db
      .from("orders")
      .select("customer_id,currency,placed_at,status,payment_status,is_test,items_json")
      .eq("store_id", storeId)
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`Orders read: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const o of rows) {
      if (!isRealDbOrder({
        status: typeof o.status === "string" ? o.status : null,
        payment_status: typeof o.payment_status === "string" ? o.payment_status : null,
        is_test: o.is_test === true,
      })) continue;
      const currency = String(o.currency ?? "").toLowerCase();
      if (!currency) continue;
      const age = o.placed_at ? now - Date.parse(String(o.placed_at)) : NaN;
      const in30 = Number.isFinite(age) && age <= 30 * DAY_MS;
      const in90 = Number.isFinite(age) && age <= 90 * DAY_MS;
      for (const i of ((o.items_json as Array<Record<string, unknown>>) ?? [])) {
        const title = normProductTitle(String(i.title ?? ""));
        if (!title || title === "—") continue;
        const qty = Number(i.quantity ?? 0);
        if (!(qty > 0)) continue;
        const a = get(keyOf(title, currency));
        const rev = qty * Number(i.unit_price ?? 0);
        a.qtyAll += qty; a.revAll += rev;
        if (in30) { a.qty30 += qty; a.rev30 += rev; }
        if (in90) { a.qty90 += qty; }
        if (typeof o.customer_id === "string") a.buyers.add(o.customer_id);
        const placed = typeof o.placed_at === "string" ? o.placed_at : null;
        if (placed && (!a.lastSold || placed > a.lastSold)) a.lastSold = placed;
      }
    }
    if (rows.length < 1000) break;
  }

  const upserts: Array<Record<string, unknown>> = [];
  const unmatched: Array<{ title: string; revenue: number; currency: string }> = [];
  for (const [k, a] of agg) {
    const sep = k.lastIndexOf("|");
    const title = k.slice(0, sep);
    const currency = k.slice(sep + 1);
    const pid = productIdByTitle.get(title);
    if (!pid) {
      unmatched.push({ title, revenue: a.revAll, currency });
      continue;
    }
    upserts.push({
      store_id: storeId,
      product_id: pid,
      currency,
      qty_all: a.qtyAll,
      qty_30d: a.qty30,
      qty_90d: a.qty90,
      revenue_all: a.revAll,
      revenue_30d: a.rev30,
      buyers_all: a.buyers.size,
      last_sold_at: a.lastSold,
    });
  }

  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await db
      .from("product_stats")
      .upsert(upserts.slice(i, i + 500), { onConflict: "product_id,currency" });
    if (error) throw new Error(`ProductStats upsert: ${error.message}`);
  }

  unmatched.sort((a, b) => b.revenue - a.revenue);
  const sum = {
    rows: upserts.length,
    matchedProducts: new Set(upserts.map((u) => String(u.product_id))).size,
    unmatchedTitles: unmatched.length,
    topUnmatched: unmatched.slice(0, 5),
  };
  log(`store=${storeId} stats rows=${sum.rows} matched=${sum.matchedProducts} unmatched=${sum.unmatchedTitles}`);
  return sum;
}

/** Fila lista para UI/agentes: producto + override + ventas (moneda primaria). */
export interface ProductWithStats {
  id: string;
  title: string;
  platform_status: string | null;
  is_active: boolean;
  is_active_override: boolean | null;
  currency: string | null;
  qty_all: number;
  revenue_all: number;
  qty_30d: number;
  buyers_all: number;
  last_sold_at: string | null;
}

export async function listProductsWithStats(
  storeId: string,
  limit = 1000,
): Promise<{ rows: ProductWithStats[]; total: number; truncated: boolean }> {
  const db = getSupabase();
  const [{ data: prods, error: pErr }, { count }] = await Promise.all([
    db
      .from("products")
      .select("id,title,platform_status,is_active,is_active_override")
      .eq("store_id", storeId)
      .order("title", { ascending: true })
      .limit(limit),
    db.from("products").select("id", { count: "exact", head: true }).eq("store_id", storeId),
  ]);
  if (pErr) throw new Error(`Products read: ${pErr.message}`);
  const total = count ?? 0;
  const { data: stats } = await db
    .from("product_stats")
    .select("product_id,currency,qty_all,revenue_all,qty_30d,buyers_all,last_sold_at")
    .eq("store_id", storeId)
    .limit(5000);
  // Moneda primaria por producto = la de mayor revenue.
  const best = new Map<string, Record<string, unknown>>();
  for (const s of (stats ?? []) as Array<Record<string, unknown>>) {
    const pid = String(s.product_id ?? "");
    const prev = best.get(pid);
    if (!prev || Number(s.revenue_all ?? 0) > Number(prev.revenue_all ?? 0)) best.set(pid, s);
  }
  const rows = ((prods ?? []) as Array<Record<string, unknown>>).map((p) => {
    const s = best.get(String(p.id));
    return {
      id: String(p.id),
      title: String(p.title ?? ""),
      platform_status: (p.platform_status as string | null) ?? null,
      is_active: p.is_active === true,
      is_active_override: (p.is_active_override as boolean | null) ?? null,
      currency: (s?.currency as string | null) ?? null,
      qty_all: Number(s?.qty_all ?? 0),
      revenue_all: Number(s?.revenue_all ?? 0),
      qty_30d: Number(s?.qty_30d ?? 0),
      buyers_all: Number(s?.buyers_all ?? 0),
      last_sold_at: (s?.last_sold_at as string | null) ?? null,
    };
  });
  // Sin truncado silencioso: el caller muestra "N en catálogo".
  if (total > rows.length) log(`store=${storeId} products truncados ${rows.length}/${total}`);
  return { rows, total, truncated: total > rows.length };
}
