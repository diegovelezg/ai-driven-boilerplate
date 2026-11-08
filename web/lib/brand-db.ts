// Marcas: vista derivada, no tabla. La marca es metadato del pedido
// (io_orders.brand); la recurrencia se calcula agrupando IOs +
// líneas por marca: pauta, inversión, pantallas y agencias.
import { getSupabase } from "@/lib/supabase";
import { BRANDS_SORT_ALIASES } from "@/lib/sort";
import { joinHaystack, matchScore, matchTokens, normalizeSearch, tokenizeSearch } from "@/lib/search-text";

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

export type BrandsSortKey = "brand" | "ios" | "investment" | "last" | "screens" | "agencies";
export type BrandsSortDir = "asc" | "desc";

export interface BrandCompany {
  id: string;
  name: string;
  kind: string | null;
  /** Roles reales en los pedidos de la marca (una empresa puede firmar y pagar). */
  roles: Array<"anunciante" | "facturación">;
}

export interface BrandIO {
  id: string;
  io_number: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  advertiser_company_id: string | null;
  billing_company_id: string | null;
  total_minor: number;
  screens: string[];
}

export interface BrandDetail {
  /** Nombre canónico (primer display visto). */
  brand: string;
  key: string;
  ios: BrandIO[];
  /** Empresas distintas vinculadas (una sola fila aunque firme y pague). */
  companies: BrandCompany[];
  screens: string[];
  total_minor: number;
  first_start: string | null;
  last_end: string | null;
  active: boolean;
}

const brandKeyOf = (b: string) => b.trim().toUpperCase();

/**
 * Ficha de una marca para el drawer: IOs (match insensible a mayúsculas,
 * igual que listBrands), empresas anunciantes/facturación, pantallas y
 * totales. La marca es derivada: no hay fila propia que leer.
 */
export async function getBrandDetail(storeId: string, brandKey: string): Promise<BrandDetail | null> {
  const key = brandKeyOf(brandKey);
  if (!key) return null;
  const db = getSupabase();
  const { data: orders, error } = await db
    .from("io_orders")
    .select("id,io_number,brand,status,starts_at,ends_at,advertiser_company_id,billing_company_id")
    .eq("store_id", storeId)
    .not("brand", "is", null);
  if (error) throw new Error(`CRM read: ${error.message}`);
  const ios = ((orders ?? []) as Array<Record<string, unknown>>).filter(
    (o) => typeof o.brand === "string" && brandKeyOf(o.brand) === key,
  );
  if (ios.length === 0) return null;
  const brand = String((ios[0] as Record<string, unknown>).brand ?? key);

  const ioIds = ios.map((o) => String(o.id));
  const [{ data: lines }, { data: screens }, { data: companies }] = await Promise.all([
    db.from("io_lines").select("io_id,rate_minor,screen_id").eq("store_id", storeId).in("io_id", ioIds),
    db.from("inv_screens").select("id,external_ref,name").eq("store_id", storeId),
    db.from("crm_companies").select("id,name,kind").eq("store_id", storeId),
  ]);
  const screenName = new Map<string, string>();
  for (const s of ((screens ?? []) as Array<Record<string, unknown>>)) {
    const ref = typeof s.external_ref === "string" && s.external_ref ? s.external_ref : String(s.name ?? s.id);
    screenName.set(String(s.id), ref);
  }
  const companyById = new Map<string, { name: string; kind: string | null }>();
  for (const c of ((companies ?? []) as Array<Record<string, unknown>>)) {
    companyById.set(String(c.id), {
      name: String(c.name ?? ""),
      kind: (c.kind as string | null) ?? null,
    });
  }

  const totalByIo = new Map<string, number>();
  const screensByIo = new Map<string, Set<string>>();
  for (const l of ((lines ?? []) as Array<Record<string, unknown>>)) {
    const ioId = String(l.io_id);
    totalByIo.set(ioId, (totalByIo.get(ioId) ?? 0) + Number(l.rate_minor ?? 0));
    const sc = typeof l.screen_id === "string" ? screenName.get(l.screen_id) : null;
    if (sc) {
      if (!screensByIo.has(ioId)) screensByIo.set(ioId, new Set());
      screensByIo.get(ioId)!.add(sc);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const detailIos: BrandIO[] = ios.map((o) => {
    const r = o as Record<string, unknown>;
    const id = String(r.id);
    return {
      id,
      io_number: String(r.io_number ?? ""),
      status: String(r.status ?? ""),
      starts_at: (r.starts_at as string | null) ?? null,
      ends_at: (r.ends_at as string | null) ?? null,
      advertiser_company_id: (r.advertiser_company_id as string | null) ?? null,
      billing_company_id: (r.billing_company_id as string | null) ?? null,
      total_minor: totalByIo.get(id) ?? 0,
      screens: [...(screensByIo.get(id) ?? [])].sort(),
    };
  });
  // Más recientes primero.
  detailIos.sort((a, b) => (b.starts_at ?? "").localeCompare(a.starts_at ?? ""));

  const byCompany = new Map<string, BrandCompany>();
  for (const o of detailIos) {
    if (o.advertiser_company_id) {
      const c = companyById.get(o.advertiser_company_id);
      if (c && !byCompany.has(o.advertiser_company_id)) {
        byCompany.set(o.advertiser_company_id, {
          id: o.advertiser_company_id,
          name: c.name,
          kind: c.kind,
          roles: [],
        });
      }
      const entry = byCompany.get(o.advertiser_company_id);
      if (entry && !entry.roles.includes("anunciante")) entry.roles.push("anunciante");
    }
    if (o.billing_company_id) {
      const c = companyById.get(o.billing_company_id);
      if (c && !byCompany.has(o.billing_company_id)) {
        byCompany.set(o.billing_company_id, {
          id: o.billing_company_id,
          name: c.name,
          kind: c.kind,
          roles: [],
        });
      }
      const entry = byCompany.get(o.billing_company_id);
      if (entry && !entry.roles.includes("facturación")) entry.roles.push("facturación");
    }
  }
  const linked = [...byCompany.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
  const screensSet = new Set<string>();
  let total_minor = 0;
  let first_start: string | null = null;
  let last_end: string | null = null;
  let active = false;
  for (const o of detailIos) {
    total_minor += o.total_minor;
    for (const s of o.screens) screensSet.add(s);
    if (o.starts_at && (!first_start || o.starts_at < first_start)) first_start = o.starts_at;
    if (o.ends_at && (!last_end || o.ends_at > last_end)) last_end = o.ends_at;
    if (o.ends_at && o.ends_at >= today && o.status !== "cancelled") active = true;
  }
  return {
    brand,
    key,
    ios: detailIos,
    companies: linked,
    screens: [...screensSet].sort(),
    total_minor,
    first_start,
    last_end,
    active,
  };
}

// SSOT: mapa de alias en lib/sort.ts (issue #8 P2). Re-export de compat.
export { BRANDS_SORT_ALIASES } from "@/lib/sort";

export function parseBrandsSort(sp: { sort?: string; dir?: string }): {
  key: BrandsSortKey;
  dir: BrandsSortDir;
} {
  const key: BrandsSortKey = BRANDS_SORT_ALIASES[sp.sort ?? ""] ?? "brand";
  if (sp.dir === "asc" || sp.dir === "desc") return { key, dir: sp.dir };
  // Texto ASC primero; métricas DESC primero (lo más relevante).
  return { key, dir: key === "brand" ? "asc" : "desc" };
}

export async function listBrands(
  storeId: string,
  opts: { q?: string; sortKey?: BrandsSortKey; sortDir?: BrandsSortDir } = {},
): Promise<BrandRow[]> {
  const db = getSupabase();
  const { data: orders, error } = await db
    .from("io_orders")
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
    db.from("io_lines").select("io_id,rate_minor,screen_id").eq("store_id", storeId).in("io_id", ioIds),
    db.from("inv_screens").select("id,external_ref,name").eq("store_id", storeId),
    db.from("crm_companies").select("id,name").eq("store_id", storeId),
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
  const tokens = tokenizeSearch(opts.q ?? "");
  const qNorm = normalizeSearch(opts.q ?? "");
  const sortKey = opts.sortKey ?? "brand";
  const ascending = (opts.sortDir ?? (sortKey === "brand" ? "asc" : "desc")) === "asc";
  // Fuzzy en JS (la marca es derivada por agregación): tildes, multi-token
  // en desorden y ranking. Mismo recall que los RPC.
  const scored = [...byBrand.values()]
    .map((r) => {
      const { screensSet, agenciesSet, ...rest } = r;
      const row = { ...rest, screens: [...screensSet].sort(), agencies: [...agenciesSet].sort() };
      if (tokens.length === 0) return { row, score: 0 };
      const hay = joinHaystack([r.brand, ...agenciesSet, ...screensSet]);
      if (!matchTokens(hay, tokens)) return { row, score: -1 };
      const first = tokens[0] ?? "";
      const brandBonus = first !== "" && normalizeSearch(r.brand).startsWith(first) ? 1 : 0;
      return { row, score: matchScore(hay, tokens, qNorm) + brandBonus };
    })
    .filter((s) => s.score >= 0);
  // Con búsqueda y sort default: relevancia primero, luego A–Z.
  if (tokens.length > 0 && sortKey === "brand" && ascending) {
    scored.sort(
      (a, b) => b.score - a.score || a.row.brand.localeCompare(b.row.brand, "es"),
    );
    return scored.map((s) => s.row);
  }
  const out = scored.map((s) => s.row);
  const cmp = (a: BrandRow, b: BrandRow): number => {
    switch (sortKey) {
      case "ios": return a.ios - b.ios;
      case "investment": return a.total_minor - b.total_minor;
      case "last": return (a.last_end ?? "") < (b.last_end ?? "") ? -1 : (a.last_end ?? "") > (b.last_end ?? "") ? 1 : 0;
      case "screens": return a.screens.length - b.screens.length;
      case "agencies": return a.agencies.length - b.agencies.length;
      default: return a.brand.localeCompare(b.brand, "es");
    }
  };
  out.sort((a, b) => (ascending ? cmp(a, b) : -cmp(a, b)));
  return out;
}
