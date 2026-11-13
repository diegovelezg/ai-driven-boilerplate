// Disponibilidad de pantallas por periodo (anti-sobreventa en la venta).
// La unidad ocupable es el slot/día: cada línea reserva `cant_slots` y cada
// booking 1 slot. La capacidad es slots propios activos (inv_slots) o el
// default del tenant (`sys_stores.default_slots_per_screen`). Una pantalla
// bloquea solo los días donde reservados + solicitados > capacidad; el resto
// visible (slots libres por día) viaja en `remaining`/`capacities`.
// Fuentes: líneas de órdenes vigentes + bookings vigentes.
// Un borrador aparta (hold) solo si está fresco (HOLD_DAYS); vencido, libera.
import { getSupabase } from "@/lib/supabase";
import { normalizeSlotsPerScreen, DEFAULT_SLOTS_PER_SCREEN } from "@/lib/store-slots";
import { normalizeLineSlots } from "@/lib/order-lines";
import type { OccupiedRange } from "@/lib/availability-utils";
import { addDays, DAY_MS, displayEndOf, isoDayPart, isValidISODate, limaDayStart, dayNumToISO, isoDayToNum } from "@/lib/format";

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
  /** Días del periodo pedido sin cupo para los slots solicitados. */
  blockedDays?: string[];
  /** Capacidad slots/día de la pantalla. */
  capacity?: number;
  /** Slots solicitados en la evaluación. */
  requested?: number;
  /** Mínimo de slots libres en el periodo pedido. */
  remaining?: number;
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
 *  Slot-aware: solo bloquean los días donde reservados + solicitados >
 *  capacidad. `slots`: cantidad pedida (una para todas o por pantalla,
 *  default 1). `excludeIoId`: ignora líneas y bookings de esa orden (editar
 *  sin chocar consigo misma). */
export async function getScreenConflicts(
  storeId: string,
  starts: string,
  ends: string,
  opts: { excludeIoId?: string | null; slots?: number | Record<string, number> } = {},
): Promise<ScreenConflict[]> {
  return (await getPeriodAvailability(storeId, null, starts, ends, opts)).conflicts;
}

/** Capacidad slots/día por pantalla: slots propios activos o default del tenant. */
export async function getScreenCapacities(
  storeId: string,
  screenIds: string[],
): Promise<Map<string, number>> {
  const db = getSupabase();
  const out = new Map<string, number>();
  if (screenIds.length === 0) return out;
  let fallback = DEFAULT_SLOTS_PER_SCREEN;
  try {
    const { data: srow } = await db
      .from("sys_stores")
      .select("default_slots_per_screen")
      .eq("id", storeId)
      .maybeSingle();
    fallback = normalizeSlotsPerScreen((srow as Record<string, unknown> | null)?.default_slots_per_screen);
  } catch {
    // default del código
  }
  const activeBy = new Map<string, number>();
  const hasAny = new Set<string>();
  // Lotes de 100: un .in() con miles de UUIDs revienta la URL (Kong 414).
  for (let i = 0; i < screenIds.length; i += 100) {
    const chunk = screenIds.slice(i, i + 100);
    const { data: slots, error } = await db
      .from("inv_slots")
      .select("screen_id,is_active")
      .eq("store_id", storeId)
      .in("screen_id", chunk);
    if (error) throw new Error(`Availability slots: ${error.message}`);
    for (const s of ((slots ?? []) as Array<Record<string, unknown>>)) {
      const id = String(s.screen_id ?? "");
      if (!id) continue;
      hasAny.add(id);
      if (s.is_active !== false) activeBy.set(id, (activeBy.get(id) ?? 0) + 1);
    }
  }
  for (const id of screenIds) out.set(id, hasAny.has(id) ? (activeBy.get(id) ?? 0) : fallback);
  return out;
}

interface AvailabilityGrid {
  ids: string[];
  capacities: Map<string, number>;
  reserved: Map<string, Map<number, number>>;
  info: Map<string, { io_number: string | null; brand: string | null; source: "order" | "booking" }>;
  /** Días con al menos un hold/borrador vigente (punto indicador). */
  holds: Map<string, Set<number>>;
}

/** Grilla reservados/día por pantalla en [fromNum, toNumExcl) (ordinales).
 *  `screenIds` null = descubre por actividad en la ventana (vía legacy). */
async function loadAvailabilityGrid(
  storeId: string,
  screenIds: string[] | null,
  fromNum: number,
  toNumExcl: number,
  opts: { excludeIoId?: string | null } = {},
): Promise<AvailabilityGrid> {
  const db = getSupabase();
  const excluded = typeof opts.excludeIoId === "string" && opts.excludeIoId ? opts.excludeIoId : null;
  const winStart = limaDayStart(dayNumToISO(fromNum));
  const winEnd = limaDayStart(dayNumToISO(toNumExcl));
  const reserved = new Map<string, Map<number, number>>();
  const info = new Map<string, { io_number: string | null; brand: string | null; source: "order" | "booking" }>();
  const holds = new Map<string, Set<number>>();
  const add = (id: string, day: number, qty: number) => {
    if (day < fromNum || day >= toNumExcl || qty <= 0) return;
    let m = reserved.get(id);
    if (!m) reserved.set(id, (m = new Map()));
    m.set(day, (m.get(day) ?? 0) + qty);
  };
  const note = (id: string, io_number: string | null, brand: string | null, source: "order" | "booking") => {
    if (!info.has(id)) info.set(id, { io_number, brand, source });
  };

  // Lotes de 100 pantallas: un .in() con miles de UUIDs revienta la URL.
  // Todas las lecturas paginan (.range) sin `limit` mudo: truncar en silencio
  // sería sobreestimar disponibilidad (sobreventa). Tope alto y ruidoso.
  const PAGE = 1000;
  const MAX_PAGES = 100;
  async function fetchPaged(
    label: string,
    build: (rangeFrom: number, rangeTo: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>,
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      const { data, error } = await build(p * PAGE, p * PAGE + PAGE - 1);
      if (error) throw new Error(`Availability ${label}: ${error.message ?? "DB read failed"}`);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
    throw new Error(`Availability ${label}: ventana demasiado grande (tope ${MAX_PAGES * PAGE} filas).`);
  }
  const chunks: Array<string[] | null> = screenIds
    ? Array.from({ length: Math.ceil(screenIds.length / 100) }, (_, i) => screenIds.slice(i * 100, i * 100 + 100))
    : [null];

  for (const chunk of chunks) {
    const lines = await fetchPaged("lines", (a, b) => {
      let linesQuery = db
        .from("io_lines")
        .select("io_id,screen_id,starts_at,ends_at,cant_slots,io_orders!insertion_order_lines_io_id_fkey!inner(io_number,brand,status,created_at)")
        .eq("store_id", storeId)
        .eq("io_orders.store_id", storeId)
        .lt("starts_at", winEnd)
        .gt("ends_at", winStart)
        .order("id")
        .range(a, b);
      if (chunk) linesQuery = linesQuery.in("screen_id", chunk);
      return linesQuery;
    });
    for (const l of lines) {
      if (excluded && String(l.io_id ?? "") === excluded) continue;
      const o = l.io_orders as unknown as Record<string, unknown> | null;
      if (!o || o.status === "cancelled") continue;
      if (o.status === "draft" && !isHoldFresh(typeof o.created_at === "string" ? o.created_at : null)) continue;
      const id = String(l.screen_id ?? "");
      if (!id) continue;
      const qtyRaw = Number(l.cant_slots ?? 1);
      const qty = Number.isFinite(qtyRaw) && qtyRaw >= 1 ? Math.floor(qtyRaw) : 1;
      const s = Math.max(isoDayToNum(isoDayPart(String(l.starts_at)) ?? ""), fromNum);
      const e = Math.min(isoDayToNum(isoDayPart(String(l.ends_at)) ?? ""), toNumExcl);
      const isHold = o.status === "draft";
      for (let d = s; d < e; d++) {
        add(id, d, qty);
        if (isHold) {
          let h = holds.get(id);
          if (!h) holds.set(id, (h = new Set()));
          h.add(d);
        }
      }
      note(
        id,
        typeof o.io_number === "string" ? o.io_number : null,
        typeof o.brand === "string" ? o.brand : null,
        "order",
      );
    }

    const slots = await fetchPaged("slots", (a, b) => {
      let slotQuery = db.from("inv_slots").select("id,screen_id").eq("store_id", storeId).order("id").range(a, b);
      if (chunk) slotQuery = slotQuery.in("screen_id", chunk);
      return slotQuery;
    });
    const slotById = new Map(
      (slots.map((s) => [String(s.id), String(s.screen_id)])),
    );
    const slotIds = [...slotById.keys()];
    for (let i = 0; i < slotIds.length; i += 100) {
      const books = await fetchPaged("bookings", (a, b) => {
        return db
          .from("inv_bookings")
          .select("slot_id,insertion_order_id,starts_at,ends_at,status,io_orders!bookings_insertion_order_id_fkey(io_number,brand)")
          .eq("store_id", storeId)
          .in("slot_id", slotIds.slice(i, i + 100))
          .neq("status", "cancelled")
          .lt("starts_at", winEnd)
          .gt("ends_at", winStart)
          .order("id")
          .range(a, b);
      });
      for (const b of books) {
        if (excluded && b.insertion_order_id != null && String(b.insertion_order_id) === excluded) continue;
        const screenId = slotById.get(String(b.slot_id));
        if (!screenId) continue;
        const s = Math.max(isoDayToNum(isoDayPart(String(b.starts_at)) ?? ""), fromNum);
        const e = Math.min(isoDayToNum(isoDayPart(String(b.ends_at)) ?? ""), toNumExcl);
        const isHold = String(b.status ?? "") === "hold";
        for (let d = s; d < e; d++) {
          add(screenId, d, 1);
          if (isHold) {
            let h = holds.get(screenId);
            if (!h) holds.set(screenId, (h = new Set()));
            h.add(d);
          }
        }
        const o = b.io_orders as unknown as Record<string, unknown> | null;
        note(
          screenId,
          o && typeof o.io_number === "string" ? o.io_number : null,
          o && typeof o.brand === "string" ? o.brand : null,
          "booking",
        );
      }
    }
  }

  const ids = screenIds ?? [...new Set([...reserved.keys()])];
  const capacities = await getScreenCapacities(storeId, ids);
  return { ids, capacities, reserved, info, holds };
}

/** Días consecutivos → rangos inclusivos (para calendarios). */
function mergeDayNums(days: number[]): OccupiedRange[] {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const out: OccupiedRange[] = [];
  let s = -1;
  let p = -1;
  for (const d of sorted) {
    if (s === -1) {
      s = p = d;
      continue;
    }
    if (d === p + 1) {
      p = d;
      continue;
    }
    out.push({ starts: dayNumToISO(s), ends: dayNumToISO(p) });
    s = p = d;
  }
  if (s !== -1) out.push({ starts: dayNumToISO(s), ends: dayNumToISO(p) });
  return out;
}

export interface PeriodAvailability {
  conflicts: ScreenConflict[];
  /** screenId → día "yyyy-mm-dd" → slots libres ese día (clampado a ≥0). */
  remaining: Record<string, Record<string, number>>;
  /** screenId → día "yyyy-mm-dd" → slots reservados ese día (sin clampar: revela sobreventa). */
  taken: Record<string, Record<string, number>>;
  capacities: Record<string, number>;
  /** screenId → días "yyyy-mm-dd" con hold/borrador vigente. */
  holds: Record<string, string[]>;
}

/** Disponibilidad slot-aware de un periodo UI (inclusivo).
 *  `screenIds` null = solo pantallas con actividad (vía legacy).
 *  `remaining`/`capacities` viajan para el resto visible; `conflicts`
 *  marca las pantallas sin cupo en algún día del periodo. */
export async function getPeriodAvailability(
  storeId: string,
  screenIds: string[] | null,
  starts: string,
  ends: string,
  opts: { excludeIoId?: string | null; slots?: number | Record<string, number> } = {},
): Promise<PeriodAvailability> {
  const startNum = isoDayToNum(assertDateStr(starts, "starts"));
  const endNum = isoDayToNum(assertDateStr(ends, "ends"));
  if (endNum < startNum) throw new Error(`Rango inválido: ${starts} > ${ends}`);
  const grid = await loadAvailabilityGrid(storeId, screenIds, startNum, endNum + 1, opts);
  const conflicts: ScreenConflict[] = [];
  const remaining: Record<string, Record<string, number>> = {};
  const taken: Record<string, Record<string, number>> = {};
  const capacities: Record<string, number> = {};
  const holds: Record<string, string[]> = {};
  const wanted = (id: string): number => {
    const raw = typeof opts.slots === "number" ? opts.slots : opts.slots?.[id];
    return normalizeLineSlots(raw) ?? 1;
  };
  for (const id of grid.ids) {
    const capacity = grid.capacities.get(id) ?? DEFAULT_SLOTS_PER_SCREEN;
    capacities[id] = capacity;
    const q = wanted(id);
    const days: Record<string, number> = {};
    const sold: Record<string, number> = {};
    const blocked: string[] = [];
    let minFree = capacity;
    for (let d = startNum; d <= endNum; d++) {
      const raw = grid.reserved.get(id)?.get(d) ?? 0;
      const day = dayNumToISO(d);
      sold[day] = Math.max(0, raw);
      const free = Math.max(0, capacity - raw);
      days[day] = free;
      if (free < minFree) minFree = free;
      if (free < q) blocked.push(day);
    }
    remaining[id] = days;
    taken[id] = sold;
    const holdDays: string[] = [];
    const hs = grid.holds.get(id);
    if (hs) {
      for (let d = startNum; d <= endNum; d++) {
        if (hs.has(d)) holdDays.push(dayNumToISO(d));
      }
    }
    if (holdDays.length > 0) holds[id] = holdDays;
    if (blocked.length > 0) {
      const hit = grid.info.get(id);
      conflicts.push({
        screen_id: id,
        io_number: hit?.io_number ?? null,
        brand: hit?.brand ?? null,
        starts: blocked[0],
        ends: blocked[blocked.length - 1],
        source: hit?.source ?? "order",
        blockedDays: blocked,
        capacity,
        requested: q,
        remaining: minFree,
      });
    }
  }
  return { conflicts, remaining, taken, capacities, holds };
}

/** Línea pedida para evaluación de cupo (fechas UI inclusivas). */
export interface LineRequest {
  screen_id: string;
  starts: string;
  ends: string;
  slots: number;
}

/** Evalúa cupo por línea (su periodo × su `q`): fail-closed ante forma
 *  inválida. Devuelve el primer choque con `blockedDays` recortados a la
 *  línea (comparación inclusiva, sin `rangesOverlap` semiabierto). */
export async function findLineConflicts(
  storeId: string,
  lines: LineRequest[],
  opts: { excludeIoId?: string | null } = {},
): Promise<{ index: number; conflict: ScreenConflict } | null> {
  const clean = lines.map((l, i) => {
    const screen_id = String(l.screen_id ?? "").trim();
    const starts = String(l.starts ?? "").trim();
    const ends = String(l.ends ?? "").trim();
    const q = normalizeLineSlots(l.slots);
    if (!screen_id || !isValidISODate(starts) || !isValidISODate(ends) || ends < starts || q === null) {
      throw new Error(`Línea ${i + 1}: periodo o slots inválidos.`);
    }
    return { screen_id, starts, ends, q };
  });
  if (clean.length === 0) return null;
  const from = clean.reduce((a, l) => (a < l.starts ? a : l.starts), clean[0].starts);
  const to = clean.reduce((a, l) => (a > l.ends ? a : l.ends), clean[0].ends);
  const ids = [...new Set(clean.map((l) => l.screen_id))];
  const grid = await loadAvailabilityGrid(storeId, ids, isoDayToNum(from), isoDayToNum(to) + 1, opts);
  for (let i = 0; i < clean.length; i++) {
    const l = clean[i];
    const capacity = grid.capacities.get(l.screen_id) ?? DEFAULT_SLOTS_PER_SCREEN;
    const blocked: string[] = [];
    for (let d = isoDayToNum(l.starts); d <= isoDayToNum(l.ends); d++) {
      const free = capacity - (grid.reserved.get(l.screen_id)?.get(d) ?? 0);
      if (free < l.q) blocked.push(dayNumToISO(d));
    }
    if (blocked.length > 0) {
      const hit = grid.info.get(l.screen_id);
      return {
        index: i,
        conflict: {
          screen_id: l.screen_id,
          io_number: hit?.io_number ?? null,
          brand: hit?.brand ?? null,
          starts: blocked[0],
          ends: blocked[blocked.length - 1],
          source: hit?.source ?? "order",
          blockedDays: blocked,
          capacity,
          requested: l.q,
          remaining: Math.max(0, Math.min(...blocked.map((b) => capacity - (grid.reserved.get(l.screen_id)?.get(isoDayToNum(b)) ?? 0)))),
        },
      };
    }
  }
  return null;
}

/** Rangos sin cupo por pantalla desde `from` (400 días), días inclusivos.
 *  Para calendarios de disponibilidad y cálculo del próximo hueco.
 *  `slots`: cupo pedido por pantalla (default 1 = día totalmente reservado);
 *  los días con resto parcial no entran al rango pero sí a `remaining`
 *  cuando el caller lo pide vía `getPeriodAvailability`. */
export async function getScreenOccupancy(
  storeId: string,
  screenIds: string[],
  from: string,
  opts: { excludeIoId?: string | null; slots?: number | Record<string, number> } = {},
): Promise<Record<string, OccupiedRange[]>> {
  assertDateStr(from, "from");
  const out: Record<string, OccupiedRange[]> = {};
  if (screenIds.length === 0) return out;
  const fromNum = isoDayToNum(from);
  const grid = await loadAvailabilityGrid(storeId, screenIds, fromNum, fromNum + 400, opts);
  const wanted = (id: string): number => {
    const raw = typeof opts.slots === "number" ? opts.slots : opts.slots?.[id];
    return normalizeLineSlots(raw) ?? 1;
  };
  for (const id of grid.ids) {
    const capacity = grid.capacities.get(id) ?? DEFAULT_SLOTS_PER_SCREEN;
    const q = wanted(id);
    const full: number[] = [];
    for (let d = fromNum; d < fromNum + 400; d++) {
      const free = capacity - (grid.reserved.get(id)?.get(d) ?? 0);
      if (free < q) full.push(d);
    }
    out[id] = mergeDayNums(full);
  }
  return out;
}
