// Lecturas de órdenes (service_role, como crm-db). La etapa se deriva en JS
// con orderStage: volumen bajo (<200), sin paginación exacta que mentir.
import { getSupabase } from "@/lib/supabase";
import { joinHaystack, matchScore, matchTokens, normalizeSearch, tokenizeSearch } from "@/lib/search-text";
import { orderStage, type OrderStageKey } from "@/lib/order-stage";
import { billingStatus, type BillingStatusKey } from "@/lib/billing-status";

export interface OrderRow {
  id: string;
  io_number: string;
  brand: string | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  advertiser_name: string | null;
  billing_name: string | null;
  lines_count: number;
  gross_minor: number;
  /** Moneda de la IO (las líneas heredan esta moneda; nunca sumar mixto). */
  currency: string;
  stage: OrderStageKey;
  stage_index: number;
  has_om: boolean;
  billing: BillingStatusKey;
  invoiced_minor: number;
  paid_minor: number;
  pending_minor: number;
  isPrepaid: boolean;
}

export const ORDER_STAGES: OrderStageKey[] = [
  "firmada",
  "materiales",
  "al_aire",
  "por_certificar",
  "cerrada",
  "cancelada",
];

const now = () => Date.now();

export async function listOrders(
  storeId: string,
  opts: { q?: string; stage?: OrderStageKey | null; billing?: BillingStatusKey | null } = {},
): Promise<OrderRow[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("io_orders")
    .select(
      "id,io_number,brand,status,starts_at,ends_at,payment_terms_days,advertiser_company_id,billing_company_id,currency",
    )
    .eq("store_id", storeId)
    .order("starts_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Orders read: ${error.message}`);
  const allRows = (data ?? []) as Array<Record<string, unknown>>;
  if (allRows.length === 0) return [];

  // Nombres primero: el filtro fuzzy cruza IO + marca + anunciante + facturación.
  const preIds = [
    ...new Set(
      allRows.flatMap((r) => [r.advertiser_company_id, r.billing_company_id].filter(Boolean)).map(String),
    ),
  ];
  const nameByPre = new Map<string, string>();
  if (preIds.length > 0) {
    const { data: preCos, error: preCosError } = await db
      .from("crm_companies")
      .select("id,name")
      .eq("store_id", storeId)
      .in("id", preIds);
    if (preCosError) throw new Error(`Orders read: ${preCosError.message}`);
    for (const c of (preCos ?? []) as Array<Record<string, unknown>>) {
      nameByPre.set(String(c.id), String(c.name ?? ""));
    }
  }
  // Fuzzy en JS (etapa y cobro se derivan aquí): tildes, multi-token y ranking.
  const tokens = tokenizeSearch(opts.q ?? "");
  const qNorm = normalizeSearch(opts.q ?? "");
  const ranked = allRows
    .map((r) => {
      if (tokens.length === 0) return { r, score: 0 };
      const hay = joinHaystack([
        r.io_number,
        r.brand,
        nameByPre.get(String(r.advertiser_company_id ?? "")),
        nameByPre.get(String(r.billing_company_id ?? "")),
      ]);
      if (!matchTokens(hay, tokens)) return { r, score: -1 };
      return { r, score: matchScore(hay, tokens, qNorm) };
    })
    .filter((s) => s.score >= 0);
  if (ranked.length === 0) return [];
  // Con búsqueda: relevancia primero (estable: conserva fecha dentro del score).
  if (tokens.length > 0) ranked.sort((a, b) => b.score - a.score);
  const rows = ranked.map((s) => s.r);
  const ids = rows.map((r) => String(r.id));

  const [lines, oms, creas, photos, invs] = await Promise.all([
    db.from("io_lines").select("io_id,rate_minor").eq("store_id", storeId).in("io_id", ids),
    db.from("io_agency_orders").select("io_id").eq("store_id", storeId).in("io_id", ids),
    db.from("io_creatives").select("io_id,qc_status,legal_status").eq("store_id", storeId).in("io_id", ids),
    db.from("io_photo_checks").select("io_id").eq("store_id", storeId).in("io_id", ids),
    db.from("io_invoices").select("io_id,amount_minor,currency,status,issue_date,due_date").eq("store_id", storeId).in("io_id", ids),
  ]);
  // Nombres ya resueltos arriba para el filtro (mismo mapa).
  const nameBy = nameByPre;
  const linesBy = new Map<string, { n: number; gross: number }>();
  for (const l of (lines.data ?? []) as Array<Record<string, unknown>>) {
    const k = String(l.io_id);
    const prev = linesBy.get(k) ?? { n: 0, gross: 0 };
    prev.n += 1;
    prev.gross += Number(l.rate_minor ?? 0);
    linesBy.set(k, prev);
  }
  const omBy = new Set(((oms.data ?? []) as Array<Record<string, unknown>>).map((o) => String(o.io_id)));
  const creaBy = new Map<string, { pending: boolean; any: boolean }>();
  for (const c of (creas.data ?? []) as Array<Record<string, unknown>>) {
    const k = String(c.io_id);
    const prev = creaBy.get(k) ?? { pending: false, any: false };
    prev.any = true;
    if (c.qc_status !== "approved" || c.legal_status !== "approved") prev.pending = true;
    creaBy.set(k, prev);
  }
  const photoBy = new Set(((photos.data ?? []) as Array<Record<string, unknown>>).map((p) => String(p.io_id)));
  const invBy = new Map<string, Array<Record<string, unknown>>>();
  for (const v of (invs.data ?? []) as Array<Record<string, unknown>>) {
    const k = String(v.io_id);
    const arr = invBy.get(k) ?? [];
    arr.push(v);
    invBy.set(k, arr);
  }

  const t = now();
  const out: OrderRow[] = rows.map((r) => {
    const id = String(r.id);
    const endsAt = r.ends_at ? Date.parse(String(r.ends_at)) : NaN;
    const crea = creaBy.get(id);
    const { index, stage } = orderStage({
      status: (r.status as string | null) ?? null,
      signed: r.status === "signed",
      hasOm: omBy.has(id),
      materialsOk: crea ? crea.any && !crea.pending : false,
      ended: Number.isFinite(endsAt) ? endsAt <= t : false,
      certified: photoBy.has(id),
    });
    const agg = linesBy.get(id) ?? { n: 0, gross: 0 };
    const invRows = invBy.get(id) ?? [];
    // Solo facturas en la moneda de la IO: nunca sumar PEN+USD.
    const orderCurrency = String(r.currency ?? "PEN").toUpperCase() || "PEN";
    const invSameCurrency = invRows.filter((v) => {
      const c = v.currency == null || String(v.currency).trim() === "" ? orderCurrency : String(v.currency).toUpperCase();
      return c === orderCurrency;
    });
    const bill = billingStatus({
      gross_minor: agg.gross,
      invoices: invSameCurrency.map((v) => ({
        amount_minor: Number(v.amount_minor ?? 0),
        status: String(v.status ?? ""),
        issue_date: (v.issue_date as string | null) ?? null,
        due_date: (v.due_date as string | null) ?? null,
      })),
      starts_at: (r.starts_at as string | null) ?? null,
      payment_terms_days:
        typeof r.payment_terms_days === "number" ? (r.payment_terms_days as number) : null,
      now: t,
    });
    return {
      id,
      io_number: String(r.io_number ?? ""),
      brand: (r.brand as string | null) ?? null,
      status: String(r.status ?? ""),
      starts_at: (r.starts_at as string | null) ?? null,
      ends_at: (r.ends_at as string | null) ?? null,
      advertiser_name: r.advertiser_company_id ? (nameBy.get(String(r.advertiser_company_id)) ?? null) : null,
      billing_name: r.billing_company_id ? (nameBy.get(String(r.billing_company_id)) ?? null) : null,
      lines_count: agg.n,
      gross_minor: agg.gross,
      currency: orderCurrency,
      stage,
      stage_index: index,
      has_om: omBy.has(id),
      billing: bill.status,
      invoiced_minor: bill.invoiced_minor,
      paid_minor: bill.paid_minor,
      pending_minor: bill.pending_minor,
      isPrepaid: bill.isPrepaid,
    };
  });
  let filtered = opts.stage ? out.filter((r) => r.stage === opts.stage) : out;
  if (opts.billing) filtered = filtered.filter((r) => r.billing === opts.billing);
  return filtered;
}

export interface OrderDetail {
  order: Record<string, unknown>;
  advertiser_name: string | null;
  billing_name: string | null;
  billing_kind: string | null;
  lines: Array<Record<string, unknown>>;
  io_agency_orders: Array<Record<string, unknown>>;
  creatives: Array<Record<string, unknown>>;
  bookings_count: number;
  photos: Array<Record<string, unknown>>;
  photos_count: number;
  invoices: Array<Record<string, unknown>>;
}

export async function getOrderDetail(storeId: string, id: string): Promise<OrderDetail | null> {
  const db = getSupabase();
  const { data: order, error } = await db
    .from("io_orders")
    .select("*")
    .eq("store_id", storeId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Order read: ${error.message}`);
  if (!order) return null;
  const o = order as Record<string, unknown>;
  const [cos, lines, oms, creas, bookings, photos, invs] = await Promise.all([
    db.from("crm_companies").select("id,name,kind").eq("store_id", storeId).in(
      "id",
      [o.advertiser_company_id, o.billing_company_id].filter(Boolean).map(String),
    ),
    db
      .from("io_lines")
      .select("id,starts_at,ends_at,rate_minor,tarifa_regular_minor,cant_meses,cant_dias,notes,screen_id")
      .eq("store_id", storeId)
      .eq("io_id", id)
      .order("starts_at", { ascending: true }),
    db.from("io_agency_orders").select("id,kind,code,portal,issued_at,document_url,notes,created_by").eq("store_id", storeId).eq("io_id", id),
    db.from("io_creatives").select("id,name,qc_status,legal_status,file_url,created_by,duration_s,width_px,height_px,aspect").eq("store_id", storeId).eq("io_id", id),
    db.from("inv_bookings").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("insertion_order_id", id),
    db.from("io_photo_checks").select("id,photo_url,video_url,taken_at,created_by").eq("store_id", storeId).eq("io_id", id).order("taken_at", { ascending: false }).limit(50),
    db.from("io_invoices").select("id,number,amount_minor,currency,status,issue_date,due_date").eq("store_id", storeId).eq("io_id", id),
  ]);
  const nameBy = new Map(
    ((cos.data ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), String(c.name ?? "")]),
  );
  const kindBy = new Map(
    ((cos.data ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), typeof c.kind === "string" ? c.kind : null]),
  );
  const lineRows = ((lines.data ?? []) as Array<Record<string, unknown>>);
  const screenIds = [...new Set(lineRows.map((l) => String(l.screen_id)).filter(Boolean))];
  let screenBy = new Map<string, { name: string; detail: string | null }>();
  if (screenIds.length > 0) {
    const { data: screens } = await db
      .from("inv_screens")
      .select("id,name,external_ref,technology,width_px,height_px,inv_venues(name)")
      .eq("store_id", storeId)
      .in("id", screenIds);
    screenBy = new Map(
      ((screens ?? []) as Array<Record<string, unknown>>).map((s) => {
        const v = s.venues as unknown as { name?: unknown } | null;
        const venue = typeof v?.name === "string" ? v.name : "";
        const w = Number(s.width_px);
        const h = Number(s.height_px);
        const res = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${w}×${h}` : "";
        const detail = [s.external_ref, venue, s.technology, res]
          .map((x) => String(x ?? "").trim())
          .filter(Boolean)
          .join(" · ");
        return [String(s.id), { name: String(s.name ?? ""), detail: detail || null }];
      }),
    );
  }
  const photoRows = ((photos.data ?? []) as Array<Record<string, unknown>>);
  return {
    order: o,
    advertiser_name: o.advertiser_company_id ? (nameBy.get(String(o.advertiser_company_id)) ?? null) : null,
    billing_name: o.billing_company_id ? (nameBy.get(String(o.billing_company_id)) ?? null) : null,
    billing_kind: o.billing_company_id ? (kindBy.get(String(o.billing_company_id)) ?? null) : null,
    lines: lineRows.map((l) => {
      const s = screenBy.get(String(l.screen_id));
      return { ...l, screen_name: s?.name ?? null, screen_detail: s?.detail ?? null };
    }),
    io_agency_orders: (oms.data ?? []) as Array<Record<string, unknown>>,
    creatives: (creas.data ?? []) as Array<Record<string, unknown>>,
    bookings_count: bookings.count ?? 0,
    photos: photoRows,
    photos_count: photoRows.length,
    invoices: (invs.data ?? []) as Array<Record<string, unknown>>,
  };
}
