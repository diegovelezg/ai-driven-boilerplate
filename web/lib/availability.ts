// Disponibilidad de pantallas por periodo (anti-sobreventa en la venta).
// La unidad ocupable es el slot, pero la orden vende por pantalla: el choque se
// evalúa a nivel pantalla (cualquier línea/booking que solape el periodo).
// Fuentes: líneas de órdenes vigentes + bookings vigentes.
// Un borrador aparta (hold) solo si está fresco (HOLD_DAYS); vencido, libera.
import { getSupabase } from "@/lib/supabase";
import type { OccupiedRange } from "@/lib/availability-utils";
import { addDays, DAY_MS, displayEndOf, isoDayPart, isValidISODate, limaDayStart } from "@/lib/format";

export { displayEndOf };

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
  return t + HOLD_DAYS * DAY_MS > now;
}

/** Fecha UI "yyyy-mm-dd" válida o throw (fail-closed: nunca {} libre). */
function assertDateStr(v: string, field: string): string {
  if (!isValidISODate(v)) {
    throw new Error(`Fecha inválida en ${field}: ${v}`);
  }
  return v;
}

/** Periodo UI (inicio/fin inclusivos "yyyy-mm-dd") → rango semiabierto ISO Lima. */
export function periodBounds(starts: string, ends: string): { qStart: string; qEnd: string } {
  assertDateStr(starts, "starts");
  assertDateStr(ends, "ends");
  if (ends < starts) throw new Error(`Rango inválido: ${starts} > ${ends}`);
  return {
    qStart: limaDayStart(starts),
    qEnd: limaDayStart(addDays(ends, 1)),
  };
}

/** Pantallas ocupadas en [starts, ends] (fechas UI inclusivas).
 *  `excludeIoId`: ignora líneas y bookings de esa orden (editar sin
 *  chocar consigo misma). */
export async function getScreenConflicts(
  storeId: string,
  starts: string,
  ends: string,
  opts: { excludeIoId?: string | null } = {},
): Promise<ScreenConflict[]> {
  const db = getSupabase();
  const { qStart, qEnd } = periodBounds(starts, ends);
  const out: ScreenConflict[] = [];
  const excluded = typeof opts.excludeIoId === "string" && opts.excludeIoId ? opts.excludeIoId : null;

  const { data: lines, error: lerr } = await db
    .from("io_lines")
    .select("io_id,screen_id,starts_at,ends_at,io_orders!insertion_order_lines_io_id_fkey!inner(io_number,brand,status,created_at)")
    .eq("store_id", storeId)
    // Cinturón + tirantes: la FK same-store ya lo garantiza, pero el join
    // embebido también se scopea (vale aunque la migración aún no esté aplicada).
    .eq("io_orders.store_id", storeId)
    .lt("starts_at", qEnd)
    .gt("ends_at", qStart);
  if (lerr) throw new Error(`Availability lines: ${lerr.message}`);
  for (const l of (lines ?? []) as Array<Record<string, unknown>>) {
    if (excluded && String(l.io_id ?? "") === excluded) continue;
    const o = l.io_orders as unknown as Record<string, unknown> | null;
    if (!o || o.status === "cancelled") continue;
    // El borrador aparta solo 7 días; vencido, libera.
    if (o.status === "draft" && !isHoldFresh(typeof o.created_at === "string" ? o.created_at : null)) continue;
    out.push({
      screen_id: String(l.screen_id),
      io_number: typeof o.io_number === "string" ? o.io_number : null,
      brand: typeof o.brand === "string" ? o.brand : null,
      starts: isoDayPart(l.starts_at) ?? "",
      ends: displayEndOf(String(l.ends_at)),
      source: "order",
    });
  }

  const { data: books, error: berr } = await db
    .from("inv_bookings")
    // io_orders es left join con io_id anulable: sin filtro embebido aquí
    // (filtrar el embebido excluiría holds sin IO). El tenant lo da el
    // store_id del booking + la FK same-store cuando hay IO.
    .select("insertion_order_id,starts_at,ends_at,status,io_orders!bookings_insertion_order_id_fkey(io_number,brand),inv_slots!bookings_slot_id_fkey!inner(screen_id)")
    .eq("store_id", storeId)
    .neq("status", "cancelled")
    .lt("starts_at", qEnd)
    .gt("ends_at", qStart);
  if (berr) throw new Error(`Availability bookings: ${berr.message}`);
  for (const b of (books ?? []) as Array<Record<string, unknown>>) {
    if (excluded && b.insertion_order_id != null && String(b.insertion_order_id) === excluded) continue;
    const slot = b.inv_slots as unknown as Record<string, unknown> | null;
    const o = b.io_orders as unknown as Record<string, unknown> | null;
    if (!slot) continue;
    out.push({
      screen_id: String(slot.screen_id),
      io_number: o && typeof o.io_number === "string" ? o.io_number : null,
      brand: o && typeof o.brand === "string" ? o.brand : null,
      starts: isoDayPart(b.starts_at) ?? "",
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
  assertDateStr(from, "from");
  const out: Record<string, OccupiedRange[]> = {};
  if (screenIds.length === 0) return out;
  const winStart = limaDayStart(from);
  const winEnd = limaDayStart(addDays(from, 400));
  const push = (id: string, starts: string, endsExcl: string) => {
    (out[id] ??= []).push({ starts: isoDayPart(starts) ?? "", ends: displayEndOf(String(endsExcl)) });
  };

  const { data: lines, error: lerr } = await db
    .from("io_lines")
    .select("screen_id,starts_at,ends_at,io_orders!insertion_order_lines_io_id_fkey!inner(status,created_at)")
    .eq("store_id", storeId)
    // Mismo scope embebido que getScreenConflicts (FK same-store + filtro).
    .eq("io_orders.store_id", storeId)
    .in("screen_id", screenIds)
    .gte("ends_at", winStart)
    .lte("starts_at", winEnd);
  if (lerr) throw new Error(`Occupancy lines: ${lerr.message}`);
  for (const l of (lines ?? []) as Array<Record<string, unknown>>) {
    const o = l.io_orders as unknown as Record<string, unknown> | null;
    if (!o || o.status === "cancelled") continue;
    if (o.status === "draft" && !isHoldFresh(typeof o.created_at === "string" ? o.created_at : null)) continue;
    push(String(l.screen_id), String(l.starts_at), String(l.ends_at));
  }

  const { data: slots, error: serr } = await db
    .from("inv_slots")
    .select("id,screen_id")
    .eq("store_id", storeId)
    .in("screen_id", screenIds);
  if (serr) throw new Error(`Occupancy slots: ${serr.message}`);
  const slotById = new Map(
    ((slots ?? []) as Array<Record<string, unknown>>).map((s) => [String(s.id), String(s.screen_id)]),
  );
  if (slotById.size > 0) {
    const { data: books, error: berr } = await db
      .from("inv_bookings")
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
