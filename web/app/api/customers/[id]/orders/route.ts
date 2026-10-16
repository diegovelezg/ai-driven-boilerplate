import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";

export interface CustomerOrderItem {
  title: string;
  quantity: number;
}

export interface CustomerOrder {
  date: string | null;
  total: number;
  currency: string | null;
  items: CustomerOrderItem[];
}

export interface CustomerRfm {
  recencyDays: number | null;
  frequency: number;
  monetary: number;
  currency: string | null;
  avgTicket: number;
  r: number | null;
  f: number | null;
  m: number | null;
  /** Segmento RFM simplificado (estándar): Nuevo|Campeón|Recurrente|Ocasional|En riesgo|Inactivo|Sin compras */
  segment: string;
}

/** Quintil 1-5 por ranking medio (empates promediados). n<=1 => 3 neutral. */
function quintile(sortedAsc: number[], v: number): number {
  const n = sortedAsc.length;
  if (n <= 1) return 3;
  const below = sortedAsc.filter((x) => x < v).length;
  const equal = sortedAsc.filter((x) => x === v).length;
  const rankMid = below + (equal - 1) / 2;
  return Math.min(5, 1 + Math.floor((rankMid / (n - 1)) * 5));
}

function segment(r: number | null, f: number): string {
  if (f === 0) return "Sin compras";
  if (f === 1 && (r ?? 0) >= 4) return "Nuevo";
  if ((r ?? 0) >= 4 && f >= 4) return "Campeón";
  if ((r ?? 0) >= 3 && f >= 3) return "Recurrente";
  if ((r ?? 5) <= 2 && f >= 3) return "En riesgo";
  if ((r ?? 5) <= 2) return "Inactivo";
  return "Ocasional";
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }
  const { id } = await params;
  if (!id) return Response.json({ error: "Falta id." }, { status: 400 });

  const db = getSupabase();
  const { data: customer, error: custErr } = await db
    .from("customers")
    .select("store_id,orders_count,total_spent,currency,last_order_at")
    .eq("id", id)
    .maybeSingle();
  if (custErr || !customer) {
    return Response.json({ error: "Customer no encontrado." }, { status: 404 });
  }

  const [{ data: orders, error }, { data: population }] = await Promise.all([
    db
      .from("orders")
      .select("total_amount,currency,placed_at,items_json")
      .eq("customer_id", id)
      .order("placed_at", { ascending: false })
      .limit(20),
    db
      .from("customers")
      .select("orders_count,total_spent,last_order_at")
      .eq("store_id", customer.store_id as string)
      .limit(5000),
  ]);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const orderRows: CustomerOrder[] = ((orders as Array<Record<string, unknown>> | null) ?? []).map((o) => ({
    date: (o.placed_at as string) ?? null,
    total: Number(o.total_amount ?? 0),
    currency: (o.currency as string) ?? null,
    items: (((o.items_json as Array<Record<string, unknown>>) ?? []).slice(0, 5)).map((i) => ({
      title: String(i.title ?? "—"),
      quantity: Number(i.quantity ?? 0),
    })),
  }));

  // RFM vs distribución de la tienda (scores 1-5; R invertida: menos días = mejor).
  const frequency = Number(customer.orders_count ?? 0);
  const monetary = Number(customer.total_spent ?? 0);
  const currency = (customer.currency as string) ?? null;
  // Fallback para filas previas al sync que puebla last_order_at.
  const lastRaw =
    (customer.last_order_at as string) ?? (orderRows[0]?.date as string | null) ?? null;
  const lastDate = lastRaw ? new Date(lastRaw) : null;
  const recencyDays =
    lastDate && !Number.isNaN(lastDate.getTime())
      ? Math.max(0, Math.floor((Date.now() - lastDate.getTime()) / 86_400_000))
      : null;
  const pop = ((population as Array<Record<string, unknown>>) ?? []).filter(
    (p) => Number(p.orders_count ?? 0) > 0,
  );
  const fPop = pop.map((p) => Number(p.orders_count ?? 0)).sort((a, b) => a - b);
  const mPop = pop.map((p) => Number(p.total_spent ?? 0)).sort((a, b) => a - b);
  const rPop = pop
    .map((p) => {
      const d = p.last_order_at ? new Date(p.last_order_at as string) : null;
      return d && !Number.isNaN(d.getTime())
        ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000))
        : null;
    })
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  const f = frequency > 0 ? quintile(fPop, frequency) : null;
  const m = frequency > 0 ? quintile(mPop, monetary) : null;
  const r = recencyDays !== null && frequency > 0 ? 6 - quintile(rPop, recencyDays) : null;

  const summary: CustomerRfm = {
    recencyDays,
    frequency,
    monetary,
    currency,
    avgTicket: frequency > 0 ? Math.round(monetary / frequency) : 0,
    r,
    f,
    m,
    segment: segment(r, frequency),
  };
  return Response.json({ orders: orderRows, summary });
}
