// Marcas: vista derivada, no tabla. La marca es metadato del pedido
// (insertion_orders.brand); la recurrencia se calcula agrupando IOs +
// líneas por marca: pauta, inversión, pantallas y agencias.
import { getSupabase } from "@/lib/supabase";

export interface BrandRow {
  brand: string;
  ios: number;
  total_minor: number;
  first_start: string | null;
  last_end: string | null;
  screens: string[];
  agencies: string[];
  active: boolean;
}

export type BrandsSortKey = "marca" | "ios" | "inversion" | "ultima" | "pantallas" | "agencias";
export type BrandsSortDir = "asc" | "desc";

export function parseBrandsSort(sp: { sort?: string; dir?: string }): {
  key: BrandsSortKey;
  dir: BrandsSortDir;
} {
  const key: BrandsSortKey =
    sp.sort === "ios" || sp.sort === "inversion" || sp.sort === "ultima" || sp.sort === "pantallas" || sp.sort === "agencias"
      ? sp.sort
      : "marca";
  if (sp.dir === "asc" || sp.dir === "desc") return { key, dir: sp.dir };
  // Texto ASC primero; métricas DESC primero (lo más relevante).
  return { key, dir: key === "marca" ? "asc" : "desc" };
}

export async function listBrands(
  storeId: string,
  opts: { q?: string; sortKey?: BrandsSortKey; sortDir?: BrandsSortDir } = {},
): Promise<BrandRow[]> {
  const db = getSupabase();
  const { data: orders, error } = await db
    .from("insertion_orders")
    .select("id,io_number,brand,status,starts_at,ends_at,billing_company_id")
    .eq("store_id", storeId)
    .not("brand", "is", null);
  if (error) throw new Error(`CRM read: ${error.message}`);
  const ios = ((orders ?? []) as Array<Record<string, unknown>>).filter((o) =>
    typeof o.brand === "string" && (o.brand as string).trim() !== "",
  );
  if (ios.length === 0) return [];

  const ioIds = ios.map((o) => String(o.id));
  const [{ data: lines }, { data: screens }, { data: companies }] = await Promise.all([
    db.from("insertion_order_lines").select("io_id,rate_minor,screen_id").eq("store_id", storeId).in("io_id", ioIds),
    db.from("screens").select("id,external_ref,name").eq("store_id", storeId),
    db.from("companies").select("id,name").eq("store_id", storeId),
  ]);
  const screenName = new Map<string, string>();
  for (const s of ((screens ?? []) as Array<Record<string, unknown>>)) {
    const ref = typeof s.external_ref === "string" && s.external_ref ? s.external_ref : String(s.name ?? s.id);
    screenName.set(String(s.id), ref);
  }
  const billingName = new Map<string, string>();
  for (const c of ((companies ?? []) as Array<Record<string, unknown>>)) {
    billingName.set(String(c.id), String(c.name ?? ""));
  }

  const today = new Date().toISOString().slice(0, 10);
  const byBrand = new Map<string, BrandRow & { screensSet: Set<string>; agenciesSet: Set<string> }>();
  const keyOf = (b: string) => b.trim().toUpperCase();
  for (const o of ios) {
    const brand = String(o.brand);
    let row = byBrand.get(keyOf(brand));
    if (!row) {
      row = { brand, ios: 0, total_minor: 0, first_start: null, last_end: null, screens: [], agencies: [], active: false, screensSet: new Set(), agenciesSet: new Set() };
      byBrand.set(keyOf(brand), row);
    }
    row.ios += 1;
    const starts = typeof o.starts_at === "string" ? o.starts_at : null;
    const ends = typeof o.ends_at === "string" ? o.ends_at : null;
    if (starts && (!row.first_start || starts < row.first_start)) row.first_start = starts;
    if (ends && (!row.last_end || ends > row.last_end)) row.last_end = ends;
    if (ends && ends >= today && String(o.status ?? "") !== "cancelled") row.active = true;
    const bill = typeof o.billing_company_id === "string" ? billingName.get(o.billing_company_id) : null;
    if (bill) row.agenciesSet.add(bill);
  }
  for (const l of ((lines ?? []) as Array<Record<string, unknown>>)) {
    const io = ios.find((o) => String(o.id) === String(l.io_id));
    if (!io) continue;
    const row = byBrand.get(keyOf(String(io.brand)));
    if (!row) continue;
    row.total_minor += Number(l.rate_minor ?? 0);
    const sc = typeof l.screen_id === "string" ? screenName.get(l.screen_id) : null;
    if (sc) row.screensSet.add(sc);
  }
  const q = (opts.q ?? "").trim().toLowerCase();
  const sortKey = opts.sortKey ?? "marca";
  const ascending = (opts.sortDir ?? (sortKey === "marca" ? "asc" : "desc")) === "asc";
  const out = [...byBrand.values()]
    .filter((r) =>
      !q ||
      r.brand.toLowerCase().includes(q) ||
      [...r.agenciesSet].some((a) => a.toLowerCase().includes(q)) ||
      [...r.screensSet].some((s) => s.toLowerCase().includes(q)),
    )
    .map(({ screensSet, agenciesSet, ...r }) => ({
      ...r,
      screens: [...screensSet].sort(),
      agencies: [...agenciesSet].sort(),
    }));
  const cmp = (a: BrandRow, b: BrandRow): number => {
    switch (sortKey) {
      case "ios": return a.ios - b.ios;
      case "inversion": return a.total_minor - b.total_minor;
      case "ultima": return (a.last_end ?? "") < (b.last_end ?? "") ? -1 : (a.last_end ?? "") > (b.last_end ?? "") ? 1 : 0;
      case "pantallas": return a.screens.length - b.screens.length;
      case "agencias": return a.agencies.length - b.agencies.length;
      default: return a.brand.localeCompare(b.brand, "es");
    }
  };
  out.sort((a, b) => (ascending ? cmp(a, b) : -cmp(a, b)));
  return out;
}
