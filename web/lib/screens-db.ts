// Lecturas de inventario DOOH (service_role). Escrituras vía Sheet/CSV en dooh-import.
//
// Búsqueda: RPC `inv_search_screens` (pg_trgm + unaccent, ranking por
// similitud, paginación real en Postgres) en un solo roundtrip.
// Si el RPC no existe (migración pendiente), fallback al filtro JS
// normalizado — nunca rompe el deploy.
import { getSupabase, isSupabaseMissingFunction } from "@/lib/supabase";
import { SCREENS_SORT_ALIASES } from "@/lib/sort";
import { joinHaystack, matchTokens, normalizeSearch, tokenizeSearch } from "@/lib/search-text";

// Re-export de compatibilidad (tests y otros módulos consumen desde aquí).
export { joinHaystack, matchTokens, normalizeSearch, tokenizeSearch };

export interface ScreenListRow {
  id: string;
  name: string;
  is_active: boolean;
  width_px: number | null;
  height_px: number | null;
  width_m: number | null;
  height_m: number | null;
  price_pen: number | null;
  impact_day: number | null;
  impressions_day: number | null;
  district: string | null;
  city: string | null;
  venue_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  external_ref: string | null;
}

export type ScreensSortKey = "name" | "supplier" | "city" | "impact" | "price";
export type ScreensSortDir = "asc" | "desc";

// SSOT: mapa de alias en lib/sort.ts (issue #8 P2). Re-export de compat.
export { SCREENS_SORT_ALIASES } from "@/lib/sort";

export function parseScreensSort(sp: { sort?: string; dir?: string }): {
  key: ScreensSortKey;
  dir: ScreensSortDir;
} {
  const key: ScreensSortKey = SCREENS_SORT_ALIASES[sp.sort ?? ""] ?? "name";
  if (sp.dir === "asc" || sp.dir === "desc") return { key, dir: sp.dir };
  return { key, dir: key === "name" || key === "supplier" || key === "city" ? "asc" : "desc" };
}

export interface ScreensFilter {
  q?: string;
  supplierId?: string | null;
  city?: string | null;
  active?: "all" | "active" | "inactive";
  sortKey?: ScreensSortKey;
  sortDir?: ScreensSortDir;
  page?: number;
  pageSize?: number;
}

/** Haystack normalizado de una fila (mismos campos que indexa el RPC). */
export function screenHaystack(s: {
  name?: unknown;
  district?: unknown;
  city?: unknown;
  venue_name?: unknown;
  supplier_name?: unknown;
  external_ref?: unknown;
}): string {
  return joinHaystack([s.name, s.district, s.city, s.venue_name, s.supplier_name, s.external_ref]);
}

/** ¿La fila contiene TODOS los tokens? (fallback JS cuando no hay RPC). */
export function matchScreenTokens(haystackNormalized: string, tokens: string[]): boolean {
  return matchTokens(haystackNormalized, tokens);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapRpcRow(r: Record<string, unknown>): ScreenListRow {
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    is_active: r.is_active === true,
    width_px: num(r.width_px),
    height_px: num(r.height_px),
    width_m: num(r.width_m),
    height_m: num(r.height_m),
    price_pen: num(r.price_pen),
    impact_day: num(r.impact_day),
    impressions_day: num(r.impressions_day),
    district: (r.district as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    venue_name: (r.venue_name as string | null) ?? null,
    supplier_id: (r.supplier_company_id as string | null) ?? null,
    supplier_name: (r.supplier_name as string | null) ?? null,
    external_ref: (r.external_ref as string | null) ?? null,
  };
}

/** Alias local del detector compartido (`@/lib/supabase`). */
const isMissingFunction = isSupabaseMissingFunction;

export async function listScreens(
  storeId: string,
  opts: ScreensFilter = {},
): Promise<{ rows: ScreenListRow[]; total: number; truncated?: boolean }> {
  const db = getSupabase();
  const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 1), 100);
  const page = Math.max(1, opts.page ?? 1);
  const sortKey = opts.sortKey ?? "name";
  const sortDir = opts.sortDir ?? "asc";
  const q = (opts.q ?? "").trim();

  // Vía rápida: un roundtrip con ranking + total exacto en Postgres.
  const rpc = await db.rpc("inv_search_screens", {
    p_store: storeId,
    p_q: q || null,
    p_supplier: opts.supplierId ?? null,
    p_city: (opts.city ?? "").trim() || null,
    p_active: opts.active ?? "all",
    p_sort: sortKey,
    p_dir: sortDir,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (!rpc.error) {
    const data = (rpc.data ?? []) as Array<Record<string, unknown>>;
    const total = data.length > 0 ? Number(data[0].total ?? 0) : 0;
    return { rows: data.map(mapRpcRow), total: Number.isFinite(total) ? total : 0 };
  }
  if (!isMissingFunction(rpc.error as { code?: string; message?: string })) {
    throw new Error(`Screens read: ${(rpc.error as { message?: string }).message ?? rpc.error}`);
  }

  // Fallback pre-migración: mismos campos y normalización, paginación honesta
  // sobre la muestra (límite documentado, no total mentiroso a escala).
  return listScreensLegacy(storeId, { ...opts, pageSize, page, sortKey, sortDir, q });
}

const LEGACY_COLUMNS =
  "id,name,is_active,width_px,height_px,width_m,height_m,price_pen,impact_day,impressions_day,supplier_company_id,external_ref,inv_venues!inner(name,district,city)";

async function listScreensLegacy(
  storeId: string,
  opts: ScreensFilter & { pageSize: number; page: number; sortKey: ScreensSortKey; sortDir: ScreensSortDir; q: string },
): Promise<{ rows: ScreenListRow[]; total: number; truncated: boolean }> {
  const db = getSupabase();
  const { pageSize, page, sortKey, sortDir } = opts;
  const asc = sortDir === "asc";

  let countQuery = db.from("inv_screens").select("id", { count: "exact", head: true }).eq("store_id", storeId);
  if (opts.supplierId) countQuery = countQuery.eq("supplier_company_id", opts.supplierId);
  if (opts.active === "active") countQuery = countQuery.eq("is_active", true);
  else if (opts.active === "inactive") countQuery = countQuery.eq("is_active", false);

  let query = db.from("inv_screens").select(LEGACY_COLUMNS).eq("store_id", storeId).limit(500);
  if (opts.supplierId) query = query.eq("supplier_company_id", opts.supplierId);
  if (opts.active === "active") query = query.eq("is_active", true);
  else if (opts.active === "inactive") query = query.eq("is_active", false);
  // Orden servido por Supabase solo en columnas propias; supplier/city se ordenan en JS.
  if (sortKey === "name") query = query.order("name", { ascending: asc });
  else if (sortKey === "impact") query = query.order("impact_day", { ascending: asc, nullsFirst: false });
  else if (sortKey === "price") query = query.order("price_pen", { ascending: asc, nullsFirst: false });
  else query = query.order("name", { ascending: true });

  const { data, error } = await query;
  if (error) throw new Error(`Screens read: ${error.message}`);
  const { count: baseTotal, error: countError } = await countQuery;
  if (countError) throw new Error(`Screens read: ${countError.message}`);
  let out = ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const venue = (r.inv_venues ?? null) as { name?: unknown; district?: unknown; city?: unknown } | null;
    return {
      id: String(r.id),
      name: String(r.name ?? ""),
      is_active: r.is_active === true,
      width_px: num(r.width_px),
      height_px: num(r.height_px),
      width_m: num(r.width_m),
      height_m: num(r.height_m),
      price_pen: num(r.price_pen),
      impact_day: num(r.impact_day),
      impressions_day: num(r.impressions_day),
      district: (venue?.district as string | null) ?? null,
      city: (venue?.city as string | null) ?? null,
      venue_name: (venue?.name as string | null) ?? null,
      supplier_id: (r.supplier_company_id as string | null) ?? null,
      supplier_name: null as string | null,
      external_ref: (r.external_ref as string | null) ?? null,
    };
  });
  // Nombres de proveedores en batch (sin embed PostgREST).
  const supIds = [...new Set(out.map((s) => s.supplier_id).filter((v): v is string => !!v))];
  if (supIds.length > 0) {
    const { data: sups, error: supError } = await db
      .from("crm_companies")
      .select("id,name")
      .eq("store_id", storeId)
      .in("id", supIds);
    if (supError) throw new Error(`Screens read: ${supError.message}`);
    const byId = new Map(
      ((sups ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), String(c.name ?? "")]),
    );
    out = out.map((s) => ({ ...s, supplier_name: s.supplier_id ? (byId.get(s.supplier_id) ?? null) : null }));
  }

  // Filtro de texto normalizado (tildes/espacios) con AND de tokens.
  const tokens = tokenizeSearch(opts.q);
  if (tokens.length > 0) {
    out = out.filter((s) => matchScreenTokens(screenHaystack(s), tokens));
  }
  if (opts.city) {
    const want = normalizeSearch(opts.city);
    out = out.filter((s) => normalizeSearch(s.city) === want);
  }
  if (sortKey === "supplier") {
    out.sort((a, b) =>
      asc
        ? (a.supplier_name ?? "").localeCompare(b.supplier_name ?? "", "es")
        : (b.supplier_name ?? "").localeCompare(a.supplier_name ?? "", "es"),
    );
  } else if (sortKey === "city") {
    out.sort((a, b) =>
      asc ? (a.city ?? "").localeCompare(b.city ?? "", "es") : (b.city ?? "").localeCompare(a.city ?? "", "es"),
    );
  }

  const sampleFilled = (data?.length ?? 0) >= 500;
  const hasJsFilter = tokens.length > 0 || !!opts.city || sortKey === "supplier" || sortKey === "city";
  // Total exacto cuando no hay filtro JS (conteo en BD); con filtro JS el
  // total vale sobre la muestra y `truncated` lo declara (la UI pinta parcial).
  const total = hasJsFilter ? out.length : (baseTotal ?? out.length);
  const from = (page - 1) * pageSize;
  // Muestra de 500: si se llenó, hay más filas fuera (truncated honesto).
  const truncated = sampleFilled;
  return { rows: out.slice(from, from + pageSize), total, truncated };
}

/** Opciones para los filtros (proveedores y ciudades con inventario). */
export async function listScreenFilterOptions(
  storeId: string,
): Promise<{ suppliers: Array<{ id: string; name: string }>; cities: string[]; truncated: boolean }> {
  const db = getSupabase();
  const [{ data: venues, count: venuesTotal }, { data: companies, count: companiesTotal }] = await Promise.all([
    db.from("inv_venues").select("city", { count: "exact" }).eq("store_id", storeId).limit(2000),
    db.from("crm_companies").select("id,name", { count: "exact" }).eq("store_id", storeId).eq("kind", "proveedor").order("name").limit(200),
  ]);
  const truncated = (venuesTotal ?? 0) > 2000 || (companiesTotal ?? 0) > 200;
  const cities = [
    ...new Set(
      ((venues ?? []) as Array<Record<string, unknown>>)
        .map((r) => (typeof r.city === "string" ? r.city.trim() : ""))
        .filter((c) => c !== ""),
    ),
  ].sort((a, b) => a.localeCompare(b, "es"));
  return {
    suppliers: ((companies ?? []) as Array<Record<string, unknown>>).map((c) => ({
      id: String(c.id),
      name: String(c.name ?? ""),
    })),
    cities,
    truncated,
  };
}

export interface ScreenDetail {
  screen: Record<string, unknown>;
  venue: Record<string, unknown> | null;
  supplier_name: string | null;
  has_embedding: boolean;
  embedding_model: string | null;
  bookings_count: number;
  lines_count: number;
}

export async function getScreenDetail(storeId: string, screenId: string): Promise<ScreenDetail | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from("inv_screens")
    .select("*, inv_venues(*)")
    .eq("store_id", storeId)
    .eq("id", screenId)
    .maybeSingle();
  if (error) throw new Error(`Screens read: ${error.message}`);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const venue = (row.inv_venues ?? null) as Record<string, unknown> | null;
  const screen: Record<string, unknown> = { ...row };
  delete screen.inv_venues;
  const screenIdStr = String(screen.id);
  const supplierId = (screen.supplier_company_id as string | null) ?? null;
  const [{ count: bookings }, { count: lines }, { data: emb }, supRes] = await Promise.all([
    db.from("inv_bookings").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("screen_id", screenIdStr),
    db.from("io_lines").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("screen_id", screenIdStr),
    db.from("inv_screen_embeddings").select("model").eq("screen_id", screenIdStr).maybeSingle(),
    supplierId
      ? db.from("crm_companies").select("name").eq("store_id", storeId).eq("id", supplierId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const supName = supRes?.data ? String((supRes.data as Record<string, unknown>).name ?? "") || null : null;
  return {
    screen,
    venue,
    supplier_name: supName,
    has_embedding: Boolean(emb),
    embedding_model: (emb as { model?: unknown } | null)?.model as string | null ?? null,
    bookings_count: bookings ?? 0,
    lines_count: lines ?? 0,
  };
}
