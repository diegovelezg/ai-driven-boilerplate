// Detalle por producto para el drawer: metadata del tenant +
// últimos movimientos. Las cifras globales por moneda salen de product_stats
// (autoritativo); los movimientos se acotan al market (?market=) cuando se pide.
import { getSupabase } from "@/lib/supabase";
import { isRealDbOrder } from "@/lib/medusa";
import {
  buildProductPidIndex,
  normProductTitle,
  resolveProductPid,
} from "@/lib/product-stats";
import { EMPTY_KEYS, resolveItemKeys } from "@/lib/metadata-map";
import { enrichOrderItems } from "@/lib/item-context";
import { displayMarket, resolveMarketScope } from "@/lib/markets";

export interface ProductDetailStats {
  currency: string;
  qtyAll: number;
  revenueAll: number;
  qty30d: number;
  qty90d: number;
  revenue30d: number;
  buyersAll: number;
  lastSoldAt: string | null;
}

export interface ProductDetailBuyer {
  customerId: string;
  email: string;
  name: string;
  company: string | null;
  qty: number;
  revenue: number;
  currency: string;
}

export interface ProductDetailMovement {
  placedAt: string | null;
  qty: number;
  unitPrice: number;
  revenue: number;
  currency: string | null;
  /** Contenido de ESA línea (key elegida en settings): contiene/categoría o null. Ninguna otra key fluye. */
  meta: {
    contiene: string | null;
    categoria: string | null;
  } | null;
}

export interface ProductDetailDTO {
  product: {
    id: string;
    title: string;
    handle: string | null;
    platformStatus: string | null;
    isActive: boolean;
    source: string | null;
    metadata: Record<string, unknown> | null;
  };
  statsByCurrency: ProductDetailStats[];
  movements: ProductDetailMovement[];
  buyers: ProductDetailBuyer[];
  marketLabel: string | null;
  currency: string | null;
  /** Conteo honesto en lo escaneado (la lista los trae todos, paginados en UI). */
  totalMatchedMovements: number;
  totalMatchedQty: number;
  scannedOrders: number;
  scanTruncated: boolean;
}

const MOVEMENT_PAGE = 500;
const MOVEMENT_SCAN_CAP = 3000;
const META_LINES_CAP = 40;

export async function loadProductDetail(
  productId: string,
  marketId: string | null | undefined,
): Promise<{ storeId: string; dto: ProductDetailDTO } | null> {
  const db = getSupabase();
  const { data: p } = await db
    .from("products")
    .select("id,store_id,source,title,handle,platform_status,is_active,metadata")
    .eq("id", productId)
    .maybeSingle();
  if (!p) return null;
  const pr = p as Record<string, unknown>;
  const storeId = String(pr.store_id ?? "");
  const title = String(pr.title ?? "");
  const normTitle = normProductTitle(title);

  const scope = marketId
    ? await resolveMarketScope(storeId, marketId)
    : null;
  const marketLabel = scope?.market ? displayMarket(scope.market) : null;
  const viewCurrency = scope?.market ? scope.market.currency.toUpperCase() : null;

  const { data: stats } = await db
    .from("product_stats")
    .select("currency,qty_all,revenue_all,qty_30d,qty_90d,revenue_30d,buyers_all,last_sold_at")
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .limit(20);

  // Mismo criterio que el sync (product_stats): ID > variante > handle > sku >
  // título exacto > título loose. El drawer antes solo comparaba `title`
  // estricto y perdía ventas que la tabla sí cuenta (puntuación, tildes,
  // renombres, líneas con product_title distinto).
  const { data: prods } = await db
    .from("products")
    .select("id,title,handle,source_id,variants_json")
    .eq("store_id", storeId)
    .limit(5000);
  const pidIndex = buildProductPidIndex(
    (prods ?? []) as Array<Record<string, unknown>>,
  );
  const indexed = pidIndex.byTitle.has(normTitle) ||
    [...pidIndex.byTitleLoose.values()].includes(productId) ||
    (prods ?? []).some((r) => String((r as Record<string, unknown>).id ?? "") === productId);

  const movements: ProductDetailMovement[] = [];
  const metaLines: Array<{ title: string; quantity: number; metadata?: unknown; oi: number }> = [];
  const buyerAgg = new Map<string, Map<string, { qty: number; revenue: number }>>();
  let scanned = 0;
  let totalMatchedMovements = 0;
  let totalMatchedQty = 0;
  let scanTruncated = false;
  for (let off = 0; ; off += MOVEMENT_PAGE) {
    let oq = db
      .from("orders")
      .select("currency,items_json,placed_at,customer_id,status,payment_status,is_test")
      .eq("store_id", storeId)
      .order("placed_at", { ascending: false })
      .order("id", { ascending: true })
      .range(off, off + MOVEMENT_PAGE - 1);
    if (scope?.market) oq = oq.or(`market_id.eq.${scope.market.id},country.is.null`);
    const { data, error } = await oq;
    if (error) throw new Error(`Orders read: ${error.message}`);
    const orows = (data ?? []) as Array<Record<string, unknown>>;
    for (const o of orows) {
      scanned += 1;
      if (!isRealDbOrder({
        status: typeof o.status === "string" ? o.status : null,
        payment_status: typeof o.payment_status === "string" ? o.payment_status : null,
        is_test: o.is_test === true,
      })) continue;
      const cur = (o.currency as string | null) ?? null;
      if (viewCurrency && cur && cur.toUpperCase() !== viewCurrency) continue;
      const items = Array.isArray(o.items_json) ? (o.items_json as Array<Record<string, unknown>>) : [];
      let qty = 0;
      let revenue = 0;
      let unitPrice: number | null = null;
      const matched: Array<{ title: string; quantity: number; metadata?: unknown }> = [];
      for (const it of items) {
        // Mismo match que computeProductStats; si el catálogo truncó el índice
        // (5000) y este producto quedó fuera, fallback al título estricto.
        const resolved = resolveProductPid(pidIndex, it);
        const isMine = resolved
          ? resolved === productId
          : !indexed && normProductTitle(String(it.title ?? "")) === normTitle;
        if (!isMine) continue;
        const q = Number(it.quantity ?? 0);
        if (!(q > 0)) continue;
        const up = Number(it.unit_price ?? 0);
        qty += q;
        revenue += q * up;
        if (unitPrice === null) unitPrice = up;
        matched.push({ title: String(it.title ?? ""), quantity: q, metadata: it.metadata });
      }
      if (qty > 0) {
        // Conteo honesto en lo escaneado (la lista los trae todos).
        totalMatchedMovements += 1;
        totalMatchedQty += qty;
        const cid = typeof o.customer_id === "string" ? o.customer_id : null;
        if (cid) {
          let perCur = buyerAgg.get(cid);
          if (!perCur) { perCur = new Map(); buyerAgg.set(cid, perCur); }
          const curKey = (cur ?? "").toUpperCase();
          const b = perCur.get(curKey) ?? { qty: 0, revenue: 0 };
          b.qty += qty;
          b.revenue += revenue;
          perCur.set(curKey, b);
        }
      }
      // La lista trae TODOS los movimientos de lo escaneado (la UI los pagina
      // de 20 en 20). El enriquecimiento de metadata sí va topado a 40 líneas.
      if (qty > 0) {
        const oi = movements.length;
        movements.push({
          placedAt: (o.placed_at as string | null) ?? null,
          qty,
          unitPrice: unitPrice ?? 0,
          revenue,
          currency: cur,
          meta: null,
        });
        for (const m of matched) {
          if (metaLines.length >= META_LINES_CAP) break;
          metaLines.push({ ...m, oi });
        }
      }
    }
    if (orows.length < MOVEMENT_PAGE) break;
    if (scanned >= MOVEMENT_SCAN_CAP) { scanTruncated = true; break; }
  }

  // Top compradores del ítem (de lo escaneado): moneda principal por comprador.
  const buyerRows = [...buyerAgg.entries()].map(([cid, perCur]) => {
    const [currency, b] = [...perCur.entries()].sort((a, b2) => b2[1].revenue - a[1].revenue)[0]!;
    return { customerId: cid, qty: b.qty, revenue: b.revenue, currency };
  }).sort((a, b) => b.revenue - a.revenue).slice(0, 20);
  let buyers: ProductDetailBuyer[] = [];
  if (buyerRows.length > 0) {
    const { data: custs } = await db
      .from("customers")
      .select("id,email,first_name,last_name,company_name")
      .eq("store_id", storeId)
      .in("id", buyerRows.map((b) => b.customerId));
    const byId = new Map(
      ((custs ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id ?? ""), c]),
    );
    buyers = buyerRows.map((b) => {
      const c = byId.get(b.customerId);
      const name = c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "";
      return {
        ...b,
        email: c ? String(c.email ?? "") : "",
        name: name || "Sin nombre",
        company: c && c.company_name ? String(c.company_name) : null,
      };
    });
  }

  // Contenido POR LÍNEA (solo key elegida en settings): se enriquece cada línea y se agrupa por movimiento.
  if (metaLines.length > 0) {
    const keys = await resolveItemKeys(storeId).catch(() => EMPTY_KEYS);
    const enriched = await enrichOrderItems(storeId, metaLines, keys).catch(() => []);
    const byOi = new Map<number, typeof enriched>();
    enriched.forEach((e, i) => {
      const oi = metaLines[i]?.oi;
      if (oi === undefined) return;
      const arr = byOi.get(oi) ?? [];
      arr.push(e);
      byOi.set(oi, arr);
    });
    for (const [oi, list] of byOi) {
      const mv = movements[oi];
      if (!mv) continue;
      let contiene: string | null = null;
      let categoria: string | null = null;
      for (const e of list) {
        if (!contiene && e.contiene) contiene = e.contiene;
        if (!categoria && e.categoria) categoria = e.categoria;
      }
      mv.meta = contiene || categoria ? { contiene, categoria } : null;
    }
  }

  return {
    storeId,
    dto: {
      product: {
        id: String(pr.id ?? ""),
        title,
        handle: (pr.handle as string | null) ?? null,
        platformStatus: (pr.platform_status as string | null) ?? null,
        isActive: pr.is_active === true,
        source: (pr.source as string | null) ?? null,
        metadata: (pr.metadata as Record<string, unknown> | null) ?? null,
      },
      statsByCurrency: ((stats ?? []) as Array<Record<string, unknown>>).map((s) => ({
        currency: String(s.currency ?? ""),
        qtyAll: Number(s.qty_all ?? 0),
        revenueAll: Number(s.revenue_all ?? 0),
        qty30d: Number(s.qty_30d ?? 0),
        qty90d: Number(s.qty_90d ?? 0),
        revenue30d: Number(s.revenue_30d ?? 0),
        buyersAll: Number(s.buyers_all ?? 0),
        lastSoldAt: (s.last_sold_at as string | null) ?? null,
      })),
      movements,
      buyers,
      marketLabel,
      currency: viewCurrency,
      totalMatchedMovements,
      totalMatchedQty,
      scannedOrders: scanned,
      scanTruncated,
    },
  };
}
