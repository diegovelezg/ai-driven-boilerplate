// TenantBrain diario (issue #25 Hito 1.3 + Hito 2.5/2.6): snapshot agnóstico en
// `store_profiles.brain_json`. Lo escribe 1 job/día (morning-run); lo leen
// writer/juez/prospect con 1 query (sin N+1 por borrador). Determinista, sin LLM:
// top activos de product_stats, marcas/categorías de item_content, ventana
// mediana y ticket p50/p80 de orders reales, patrones de repite.
import { getSupabase } from "@/lib/supabase";
import { isRealDbOrder } from "@/lib/medusa";
import { normProductTitleLoose } from "@/lib/product-stats";

export interface BrainTopProducto {
  title: string;
  revenue: number;
  qty: number;
  buyers: number;
  currency: string;
}

export interface TenantBrain {
  version: 1;
  updatedAt: string;
  shopCurrency: string | null;
  vertical: string | null;
  catalog: string | null;
  topProductos: BrainTopProducto[];
  topMarcas: Array<{ marca: string; lines: number }>;
  topCategorias: Array<{ categoria: string; lines: number }>;
  ventanaMedianaDias: number | null;
  ticketP50: number | null;
  ticketP80: number | null;
  ticketCurrency: string | null;
  patronesRepite: {
    repeatRate: number | null;
    topRepeatTitles: Array<{ title: string; buyers: number }>;
    categoriaRepite: Array<{ categoria: string; rate: number }>;
  };
  vozCliente: string[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/** Lee el brain (1 query). null si nunca se computó. */
export async function getTenantBrain(storeId: string): Promise<TenantBrain | null> {
  try {
    const { data, error } = await getSupabase()
      .from("store_profiles")
      .select("brain_json")
      .eq("store_id", storeId)
      .maybeSingle();
    if (error || !data) return null;
    const v = (data as Record<string, unknown>).brain_json as unknown;
    if (!v || typeof v !== "object") return null;
    const b = v as TenantBrain;
    if (b.version !== 1 || !Array.isArray(b.topProductos)) return null;
    return b;
  } catch {
    return null;
  }
}

/** ¿El brain está fresco (<24h)? */
export function isBrainFresh(b: TenantBrain | null, nowMs = Date.now()): boolean {
  if (!b?.updatedAt) return false;
  const ms = Date.parse(b.updatedAt);
  if (Number.isNaN(ms)) return false;
  return nowMs - ms < 24 * 60 * 60 * 1000;
}

export async function saveTenantBrain(storeId: string, brain: TenantBrain): Promise<void> {
  const { error } = await getSupabase()
    .from("store_profiles")
    .upsert({ store_id: storeId, brain_json: brain }, { onConflict: "store_id" });
  if (error) throw new Error(`Brain save: ${error.message}`);
}

/** Cómputo determinista del brain (paginado, sin N+1). */
export async function computeTenantBrain(storeId: string): Promise<TenantBrain> {
  const db = getSupabase();
  const [{ data: prof }, { data: shop }] = await Promise.all([
    db.from("store_profiles").select("vertical_detected,catalog_type").eq("store_id", storeId).maybeSingle(),
    db.from("stores").select("shop_currency").eq("id", storeId).maybeSingle(),
  ]);
  const shopCurrency = ((shop as Record<string, unknown> | null)?.shop_currency as string | null) ?? null;
  const vertical = ((prof as Record<string, unknown> | null)?.vertical_detected as string | null) ?? null;
  const catalog = ((prof as Record<string, unknown> | null)?.catalog_type as string | null) ?? null;

  // Top productos activos (product_stats + products, moneda de la tienda primero).
  const [{ data: stats }, { data: prods }] = await Promise.all([
    db.from("product_stats").select("product_id,currency,qty_all,revenue_all,buyers_all").eq("store_id", storeId).limit(5000),
    db.from("products").select("id,title,is_active").eq("store_id", storeId).limit(5000),
  ]);
  const titleById = new Map<string, { title: string; active: boolean }>();
  for (const p of ((prods ?? []) as Array<Record<string, unknown>>)) {
    titleById.set(String(p.id), { title: String(p.title ?? ""), active: p.is_active === true });
  }
  const wantCur = shopCurrency?.toUpperCase() ?? null;
  const scored = (((stats ?? []) as Array<Record<string, unknown>>)
    .map((s) => {
      const meta = titleById.get(String(s.product_id ?? ""));
      if (!meta || !meta.title) return null;
      return {
        title: meta.title,
        active: meta.active,
        revenue: Number(s.revenue_all ?? 0),
        qty: Number(s.qty_all ?? 0),
        buyers: Number(s.buyers_all ?? 0),
        currency: String(s.currency ?? ""),
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x && x.active) as Array<{
    title: string; active: boolean; revenue: number; qty: number; buyers: number; currency: string;
  }>);
  scored.sort((a, b) => {
    const ac = wantCur ? (a.currency.toUpperCase() === wantCur ? 0 : 1) : 0;
    const bc = wantCur ? (b.currency.toUpperCase() === wantCur ? 0 : 1) : 0;
    if (ac !== bc) return ac - bc;
    return b.revenue - a.revenue;
  });
  const topProductos: BrainTopProducto[] = scored.slice(0, 5).map((s) => ({
    title: s.title, revenue: s.revenue, qty: s.qty, buyers: s.buyers, currency: s.currency,
  }));

  // Marcas/categorías (item_content, hasta 5k filas).
  const marcaCount = new Map<string, number>();
  const catCount = new Map<string, number>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db
      .from("item_content")
      .select("content_json")
      .eq("store_id", storeId)
      .order("content_hash", { ascending: true })
      .range(off, off + 999);
    if (error) break;
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const j = r.content_json as Record<string, unknown> | null;
      if (!j || typeof j !== "object") continue;
      const m = typeof j.marca === "string" ? j.marca.trim().slice(0, 80) : "";
      const c = typeof j.categoria === "string" ? j.categoria.trim().slice(0, 80) : "";
      if (m) marcaCount.set(m, (marcaCount.get(m) ?? 0) + 1);
      if (c) catCount.set(c, (catCount.get(c) ?? 0) + 1);
    }
    if (rows.length < 1000) break;
    if (off >= 4000) break;
  }
  const topMarcas = [...marcaCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([marca, lines]) => ({ marca, lines }));
  const topCategorias = [...catCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([categoria, lines]) => ({ categoria, lines }));

  // Orders reales recientes (ventana + ticket + repite). Paginado 1k, cap 10k.
  const tickets: number[] = [];
  const duraciones: number[] = [];
  const buyerOrders = new Map<string, number>();
  let buyers = 0;
  let repeat = 0;
  const titleBuyers = new Map<string, Set<string>>();
  // repeat por categoría necesita join con contenido: se aproxima por título.
  {
    const { data: custs } = await db.from("customers").select("id,orders_count").eq("store_id", storeId).limit(10000);
    for (const c of ((custs ?? []) as Array<Record<string, unknown>>)) {
      const n = Number(c.orders_count ?? 0);
      if (n > 0) {
        buyers += 1;
        if (n >= 2) repeat += 1;
      }
      if (typeof c.id === "string") buyerOrders.set(c.id, n);
    }
  }
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db
      .from("orders")
      .select("customer_id,total_amount,currency,status,payment_status,is_test,items_json")
      .eq("store_id", storeId)
      .order("placed_at", { ascending: false })
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) break;
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const o of rows) {
      if (!isRealDbOrder({ status: typeof o.status === "string" ? o.status : null, payment_status: typeof o.payment_status === "string" ? o.payment_status : null, is_test: o.is_test === true })) continue;
      const cur = (o.currency as string | null) ?? null;
      if (wantCur && cur && cur.toUpperCase() !== wantCur) continue;
      const t = Number(o.total_amount ?? 0);
      if (t > 0) tickets.push(t);
      const items = Array.isArray(o.items_json) ? (o.items_json as Array<Record<string, unknown>>) : [];
      const cid = typeof o.customer_id === "string" ? o.customer_id : "";
      for (const it of items) {
        // Agrupación loose canónica (issue #29): "cdra." ≙ "cdra", sin tildes.
        const title = normProductTitleLoose(String(it.title ?? "") || String(it.product_title ?? ""));
        if (!title || title === "—") continue;
        if (cid) {
          let s = titleBuyers.get(title);
          if (!s) { s = new Set(); titleBuyers.set(title, s); }
          s.add(cid);
        }
        const md = (it.metadata as Record<string, unknown> | null) ?? null;
        if (md) {
          // Solo keys de ventana (roles.fecha o patrón fecha/entrega/pauta).
          // Mezclar created_at con pauta sesgaba la mediana (P2).
          const ds: string[] = [];
          for (const [mk, mv] of Object.entries(md)) {
            if (typeof mv !== "string") continue;
            const ms = mv.trim();
            if (!/^\d{4}-\d{2}-\d{2}/.test(ms)) continue;
            if (!/date|start|end|fecha|entrega|pauta|ventana|reserva|booking/i.test(mk)) continue;
            ds.push(ms.slice(0, 10));
          }
          if (ds.length >= 2) {
            ds.sort();
            const d = (Date.parse(ds[ds.length - 1]) - Date.parse(ds[0])) / 86_400_000;
            if (Number.isFinite(d) && d >= 0 && d <= 365) duraciones.push(Math.round(d));
          } else if (ds.length === 1) {
            duraciones.push(0);
          }
        }
      }
    }
    if (rows.length < 1000) break;
    if (off >= 9000) break;
  }
  tickets.sort((a, b) => a - b);
  const ticketP50 = percentile(tickets, 50);
  const ticketP80 = percentile(tickets, 80);
  const positiveDur = duraciones.filter((d) => d > 0);
  const ventanaMedianaDias = median(positiveDur.length > 0 ? positiveDur : duraciones);
  const topRepeatTitles = [...titleBuyers.entries()]
    .map(([title, s]) => ({ title, buyers: s.size }))
    .sort((a, b) => b.buyers - a.buyers)
    .slice(0, 5);
  const repeatRate = buyers > 0 ? repeat / buyers : null;

  // Voz del cliente: prose frecuente de item_content texto_visible (top términos, sin LLM).
  // Stopwords generales (sin vocabulario de tenant).
  let vozCliente: string[] = [];
  try {
    const { data } = await db.from("item_content").select("content_json").eq("store_id", storeId).limit(2000);
    const words = new Map<string, number>();
    for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
      const j = r.content_json as Record<string, unknown> | null;
      const t = j && typeof j.texto_visible === "string" ? j.texto_visible : "";
      for (const w of t.toLowerCase().replace(/[^a-záéíóúñü\s]/gi, " ").split(/\s+/)) {
        const x = w.trim();
        if (x.length >= 5 && x.length <= 20) words.set(x, (words.get(x) ?? 0) + 1);
      }
    }
    const stop = new Set(["desde", "hasta", "entre", "todos", "todas", "nuevo", "nueva", "disponible", "servicios", "nuestro", "nuestra", "gracias", "todos"]);
    vozCliente = [...words.entries()].filter(([w]) => !stop.has(w)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  } catch {
    vozCliente = [];
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    shopCurrency,
    vertical,
    catalog,
    topProductos,
    topMarcas,
    topCategorias,
    ventanaMedianaDias,
    ticketP50,
    ticketP80,
    ticketCurrency: shopCurrency,
    patronesRepite: {
      repeatRate,
      topRepeatTitles,
      categoriaRepite: topCategorias.map((c) => ({ categoria: c.categoria, rate: 0 })),
    },
    vozCliente,
  };
}
