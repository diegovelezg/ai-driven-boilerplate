import { getSupabase } from "@/lib/supabase";
import { requireStoreAccess } from "@/lib/api/guard";
import { displayEndOf, isHoldFresh } from "@/lib/availability";
import { addDays, todayLima, type OccupiedRange } from "@/lib/availability-utils";

export interface OccupancyItem {
  starts: string;
  ends: string;
  io_number: string | null;
  brand: string | null;
  status: string;
  source: "order" | "booking";
}

function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * GET /api/screens/:id/occupancy?past=90&future=120 — ocupación de una pantalla.
 * Ventana [hoy-past, hoy+future] (días inclusivos). Misma semántica que
 * lib/availability: excluye canceladas; el borrador aparta solo 7 días.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: screenId } = await params;
  try {
    const db = getSupabase();
    const { data } = await db.from("inv_screens").select("store_id").eq("id", screenId).maybeSingle();
    if (!data) return Response.json({ error: "Pantalla no encontrada." }, { status: 404 });
    const storeId = String((data as Record<string, unknown>).store_id ?? "");
    const access = await requireStoreAccess(storeId);
    if (access instanceof Response) return Response.json({ error: "Pantalla no encontrada." }, { status: 404 });

    const url = new URL(req.url);
    const clamp = (v: string | null, fb: number) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n <= 365 ? n : fb;
    };
    const past = clamp(url.searchParams.get("past"), 90);
    const future = clamp(url.searchParams.get("future"), 120);
    const today = todayLima();
    const from = addDays(today, -past);
    const to = addDays(today, future);
    const qStart = `${from}T00:00:00-05:00`;
    const [y, m, d] = to.split("-").map(Number);
    const endExcl = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
    const qEnd = `${toISODate(endExcl)}T00:00:00-05:00`;

    const items: OccupancyItem[] = [];

    const { data: lines, error: lerr } = await db
      .from("io_lines")
      .select("starts_at,ends_at,io_orders!inner(io_number,brand,status,created_at)")
      .eq("store_id", storeId)
      .eq("screen_id", screenId)
      .lt("starts_at", qEnd)
      .gt("ends_at", qStart);
    if (lerr) throw new Error(`Occupancy lines: ${lerr.message}`);
    for (const l of (lines ?? []) as Array<Record<string, unknown>>) {
      const o = l.io_orders as unknown as Record<string, unknown> | null;
      if (!o || o.status === "cancelled") continue;
      if (o.status === "draft" && !isHoldFresh(typeof o.created_at === "string" ? o.created_at : null)) continue;
      items.push({
        starts: String(l.starts_at).slice(0, 10),
        ends: displayEndOf(String(l.ends_at)),
        io_number: typeof o.io_number === "string" ? o.io_number : null,
        brand: typeof o.brand === "string" ? o.brand : null,
        status: typeof o.status === "string" ? o.status : "—",
        source: "order",
      });
    }

    const { data: slots, error: serr } = await db
      .from("inv_slots")
      .select("id")
      .eq("store_id", storeId)
      .eq("screen_id", screenId);
    if (serr) throw new Error(`Occupancy slots: ${serr.message}`);
    const slotIds = ((slots ?? []) as Array<Record<string, unknown>>).map((s) => String(s.id));
    if (slotIds.length > 0) {
      const { data: books, error: berr } = await db
        .from("inv_bookings")
        .select("starts_at,ends_at,status,io_orders(io_number,brand)")
        .eq("store_id", storeId)
        .in("slot_id", slotIds)
        .neq("status", "cancelled")
        .lt("starts_at", qEnd)
        .gt("ends_at", qStart);
      if (berr) throw new Error(`Occupancy bookings: ${berr.message}`);
      for (const b of (books ?? []) as Array<Record<string, unknown>>) {
        const o = b.io_orders as unknown as Record<string, unknown> | null;
        items.push({
          starts: String(b.starts_at).slice(0, 10),
          ends: displayEndOf(String(b.ends_at)),
          io_number: o && typeof o.io_number === "string" ? o.io_number : null,
          brand: o && typeof o.brand === "string" ? o.brand : null,
          status: typeof b.status === "string" ? b.status : "—",
          source: "booking",
        });
      }
    }

    items.sort((a, b) => (a.starts < b.starts ? -1 : a.starts > b.starts ? 1 : 0));
    const ranges: OccupiedRange[] = items.map((i) => ({ starts: i.starts, ends: i.ends }));
    return Response.json({ from, to, today, ranges, items });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
