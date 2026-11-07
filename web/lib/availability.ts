// Disponibilidad de pantallas por periodo (anti-sobreventa en la venta).
// La unidad ocupable es el slot, pero la orden vende por pantalla: el choque se
// evalúa a nivel pantalla (cualquier línea/booking que solape el periodo).
// Fuentes: líneas de órdenes vigentes + bookings vigentes.
// Un borrador aparta (hold) solo si está fresco (HOLD_DAYS); vencido, libera.
import { getSupabase } from "@/lib/supabase";
import type { OccupiedRange } from "@/lib/availability-utils";

/** Días que un borrador aparta pantallas. Vencido, libera automáticamente. */
export const HOLD_DAYS = 7;

export interface ScreenConflict {
  screen_id: string;
  io_number: string | null;
  brand: string | null;
  starts: string;
  ends: string;
  source: "order" | "booking";
}

/** Solape de rangos semiabiertos [aStart,aEnd) vs [bStart,bEnd) (ISO ordenable). */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** ¿El hold (borrador) sigue vigente? created_at + HOLD_DAYS > ahora. */
export function isHoldFresh(createdAt: string | null | undefined, now = Date.now()): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return t + HOLD_DAYS * 86_400_000 > now;
}

/** Fin exclusivo ISO (BD) → día inclusivo "yyyy-mm-dd" para mostrar. */
export function displayEndOf(exclusiveIso: string): string {
  const t = Date.parse(exclusiveIso);
  if (Number.isNaN(t)) return exclusiveIso.slice(0, 10);
  const d = new Date(t - 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Periodo UI (inicio/fin inclusivos "yyyy-mm-dd") → rango semiabierto ISO Lima. */
export function periodBounds(starts: string, ends: string): { qStart: string; qEnd: string } {
  const [y, m, d] = ends.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    qStart: `${starts}T00:00:00-05:00`,
    qEnd: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T00:00:00-05:00`,
  };
}

/** Pantallas ocupadas en [starts, ends] (fechas UI inclusivas). */
export async function getScreenConflicts(
  storeId: string,
  starts: string,
  ends: string,
): Promise<ScreenConflict[]> {
  const db = getSupabase();
  const { qStart, qEnd } = periodBounds(starts, ends);
  const out: ScreenConflict[] = [];

  const { data: lines, error: lerr } = await db
    .from("insertion_order_lines")
    .select("screen_id,starts_at,ends_at,insertion_orders!inner(io_number,brand,status,created_at)")
    .eq("store_id", storeId)
    .lt("starts_at", qEnd)
    .gt("ends_at", qStart);
  if (lerr) throw new Error(`Availability lines: ${lerr.message}`);
  for (const l of (lines ?? []) as Array<Record<string, unknown>>) {
    const o = l.insertion_orders as unknown as Record<string, unknown> | null;
    if (!o || o.status === "cancelled") continue;
    // El borrador aparta solo 7 días; vencido, libera.
    if (o.status === "draft" && !isHoldFresh(typeof o.created_at === "string" ? o.created_at : null)) continue;
    out.push({
      screen_id: String(l.screen_id),
      io_number: typeof o.io_number === "string" ? o.io_number : null,
      brand: typeof o.brand === "string" ? o.brand : null,
      starts: String(l.starts_at).slice(0, 10),
      ends: displayEndOf(String(l.ends_at)),
      source: "order",
    });
  }

  const { data: books, error: berr } = await db
    .from("bookings")
    .select("starts_at,ends_at,status,insertion_orders(io_number,brand),inventory_slots!inner(screen_id)")
    .eq("store_id", storeId)
    .neq("status", "cancelled")
    .lt("starts_at", qEnd)
    .gt("ends_at", qStart);
  if (berr) throw new Error(`Availability bookings: ${berr.message}`);
  for (const b of (books ?? []) as Array<Record<string, unknown>>) {
    const slot = b.inventory_slots as unknown as Record<string, unknown> | null;
    const o = b.insertion_orders as unknown as Record<string, unknown> | null;
    if (!slot) continue;
    out.push({
      screen_id: String(slot.screen_id),
      io_number: o && typeof o.io_number === "string" ? o.io_number : null,
      brand: o && typeof o.brand === "string" ? o.brand : null,
      starts: String(b.starts_at).slice(0, 10),
      ends: displayEndOf(String(b.ends_at)),
      source: "booking",
    });
  }
  return out;
}

/** Rangos ocupados por pantalla desde `from` (400 días), días inclusivos.
 *  Para calendarios de disponibilidad y cálculo del próximo hueco. */
export async function getScreenOccupancy(
  storeId: string,
  screenIds: string[],
  from: string,
): Promise<Record<string, OccupiedRange[]>> {
  const db = getSupabase();
  const out: Record<string, OccupiedRange[]> = {};
  if (screenIds.length === 0) return out;
  const [y, m, d] = from.split("-").map(Number);
  const anchorEnd = new Date(Date.UTC(y, m - 1, d) + 400 * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const winStart = `${from}T00:00:00-05:00`;
  const winEnd = `${anchorEnd.getUTCFullYear()}-${p(anchorEnd.getUTCMonth() + 1)}-${p(anchorEnd.getUTCDate())}T00:00:00-05:00`;
  const push = (id: string, starts: string, endsExcl: string) => {
    (out[id] ??= []).push({ starts: String(starts).slice(0, 10), ends: displayEndOf(String(endsExcl)) });
  };

  const { data: lines, error: lerr } = await db
    .from("insertion_order_lines")
    .select("screen_id,starts_at,ends_at,insertion_orders!inner(status,created_at)")
    .eq("store_id", storeId)
    .in("screen_id", screenIds)
    .gte("ends_at", winStart)
    .lte("starts_at", winEnd);
  if (lerr) throw new Error(`Occupancy lines: ${lerr.message}`);
  for (const l of (lines ?? []) as Array<Record<string, unknown>>) {
    const o = l.insertion_orders as unknown as Record<string, unknown> | null;
    if (!o || o.status === "cancelled") continue;
    if (o.status === "draft" && !isHoldFresh(typeof o.created_at === "string" ? o.created_at : null)) continue;
    push(String(l.screen_id), String(l.starts_at), String(l.ends_at));
  }

  const { data: slots, error: serr } = await db
    .from("inventory_slots")
    .select("id,screen_id")
    .eq("store_id", storeId)
    .in("screen_id", screenIds);
  if (serr) throw new Error(`Occupancy slots: ${serr.message}`);
  const slotById = new Map(
    ((slots ?? []) as Array<Record<string, unknown>>).map((s) => [String(s.id), String(s.screen_id)]),
  );
  if (slotById.size > 0) {
    const { data: books, error: berr } = await db
      .from("bookings")
      .select("slot_id,starts_at,ends_at,status")
      .eq("store_id", storeId)
      .in("slot_id", [...slotById.keys()])
      .neq("status", "cancelled")
      .gte("ends_at", winStart)
      .lte("starts_at", winEnd);
    if (berr) throw new Error(`Occupancy bookings: ${berr.message}`);
    for (const b of (books ?? []) as Array<Record<string, unknown>>) {
      const screenId = slotById.get(String(b.slot_id));
      if (!screenId) continue;
      push(screenId, String(b.starts_at), String(b.ends_at));
    }
  }
  return out;
}
