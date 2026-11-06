// Lecturas de órdenes (service_role, como crm-db). La etapa se deriva en JS
// con orderStage: volumen bajo (<200), sin paginación exacta que mentir.
import { getSupabase } from "@/lib/supabase";
import { orderStage, type OrderStageKey } from "@/lib/order-stage";

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
  stage: OrderStageKey;
  stage_index: number;
}

export const ORDER_STAGES: OrderStageKey[] = [
  "firmada",
  "materiales",
  "al_aire",
  "por_certificar",
  "por_cobrar",
  "cerrada",
  "cancelada",
];

const now = () => Date.now();

export async function listOrders(
  storeId: string,
  opts: { q?: string; stage?: OrderStageKey | null } = {},
): Promise<OrderRow[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("insertion_orders")
    .select(
      "id,io_number,brand,status,starts_at,ends_at,advertiser_company_id,billing_company_id",
    )
    .eq("store_id", storeId)
    .order("starts_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Orders read: ${error.message}`);
  let rows = (data ?? []) as Array<Record<string, unknown>>;
  const q = (opts.q ?? "").trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      [r.io_number, r.brand].some((v) => String(v ?? "").toLowerCase().includes(q)),
    );
  }
  if (rows.length === 0) return [];
  const ids = rows.map((r) => String(r.id));

  const [cos, lines, oms, creas, photos, invs] = await Promise.all([
    db
      .from("companies")
      .select("id,name")
      .eq("store_id", storeId)
      .in(
        "id",
        [...new Set(rows.flatMap((r) => [r.advertiser_company_id, r.billing_company_id]).filter(Boolean))].map(String),
      ),
    db.from("insertion_order_lines").select("io_id,rate_minor").eq("store_id", storeId).in("io_id", ids),
    db.from("agency_orders").select("io_id").eq("store_id", storeId).in("io_id", ids),
    db.from("creatives").select("io_id,qc_status,legal_status").eq("store_id", storeId).in("io_id", ids),
    db.from("photo_checks").select("io_id").eq("store_id", storeId).in("io_id", ids),
    db.from("invoices").select("io_id,status").eq("store_id", storeId).in("io_id", ids),
  ]);
  const nameBy = new Map(
    ((cos.data ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), String(c.name ?? "")]),
  );
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
  const paidBy = new Set(
    ((invs.data ?? []) as Array<Record<string, unknown>>)
      .filter((v) => String(v.status) === "paid")
      .map((v) => String(v.io_id)),
  );

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
      paid: paidBy.has(id),
    });
    const agg = linesBy.get(id) ?? { n: 0, gross: 0 };
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
      stage,
      stage_index: index,
    };
  });
  return opts.stage ? out.filter((r) => r.stage === opts.stage) : out;
}

export interface OrderDetail {
  order: Record<string, unknown>;
  advertiser_name: string | null;
  billing_name: string | null;
  lines: Array<Record<string, unknown>>;
  agency_orders: Array<Record<string, unknown>>;
  creatives: Array<Record<string, unknown>>;
  bookings_count: number;
  photos_count: number;
  invoices: Array<Record<string, unknown>>;
}

export async function getOrderDetail(storeId: string, id: string): Promise<OrderDetail | null> {
  const db = getSupabase();
  const { data: order, error } = await db
    .from("insertion_orders")
    .select("*")
    .eq("store_id", storeId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Order read: ${error.message}`);
  if (!order) return null;
  const o = order as Record<string, unknown>;
  const [cos, lines, oms, creas, bookings, photos, invs] = await Promise.all([
    db.from("companies").select("id,name").eq("store_id", storeId).in(
      "id",
      [o.advertiser_company_id, o.billing_company_id].filter(Boolean).map(String),
    ),
    db
      .from("insertion_order_lines")
      .select("id,starts_at,ends_at,rate_minor,tarifa_regular_minor,cant_meses,cant_dias,notes,screen_id")
      .eq("store_id", storeId)
      .eq("io_id", id)
      .order("starts_at", { ascending: true }),
    db.from("agency_orders").select("id,kind,code,portal,issued_at,notes").eq("store_id", storeId).eq("io_id", id),
    db.from("creatives").select("id,name,qc_status,legal_status,file_url").eq("store_id", storeId).eq("io_id", id),
    db.from("bookings").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("insertion_order_id", id),
    db.from("photo_checks").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("io_id", id),
    db.from("invoices").select("id,number,amount_minor,currency,status,issue_date,due_date").eq("store_id", storeId).eq("io_id", id),
  ]);
  const nameBy = new Map(
    ((cos.data ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), String(c.name ?? "")]),
  );
  const lineRows = ((lines.data ?? []) as Array<Record<string, unknown>>);
  const screenIds = [...new Set(lineRows.map((l) => String(l.screen_id)).filter(Boolean))];
  let screenBy = new Map<string, string>();
  if (screenIds.length > 0) {
    const { data: screens } = await db.from("screens").select("id,name").eq("store_id", storeId).in("id", screenIds);
    screenBy = new Map(
      ((screens ?? []) as Array<Record<string, unknown>>).map((s) => [String(s.id), String(s.name ?? "")]),
    );
  }
  return {
    order: o,
    advertiser_name: o.advertiser_company_id ? (nameBy.get(String(o.advertiser_company_id)) ?? null) : null,
    billing_name: o.billing_company_id ? (nameBy.get(String(o.billing_company_id)) ?? null) : null,
    lines: lineRows.map((l) => ({ ...l, screen_name: screenBy.get(String(l.screen_id)) ?? null })),
    agency_orders: (oms.data ?? []) as Array<Record<string, unknown>>,
    creatives: (creas.data ?? []) as Array<Record<string, unknown>>,
    bookings_count: bookings.count ?? 0,
    photos_count: photos.count ?? 0,
    invoices: (invs.data ?? []) as Array<Record<string, unknown>>,
  };
}
