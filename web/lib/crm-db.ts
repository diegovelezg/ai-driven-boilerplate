// Lecturas CRM (service_role, como customers-db). Escrituras en crm-actions.ts.
import { getSupabase, isSupabaseMissingFunction } from "@/lib/supabase";
import { COMPANIES_SORT_ALIASES } from "@/lib/sort";
import type { CompanyKind, CrmStatusFilter } from "@/lib/crm";

export interface CrmCompany {
  id: string;
  store_id: string;
  name: string;
  kind: CompanyKind | null;
  tax_id: string | null;
  domain: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  external_ref: string | null;
  contacts_count: number;
  /** Borrado lógico: null = activa. Listas y pickers muestran activas. */
  deleted_at: string | null;
}

export interface CrmContact {
  id: string;
  store_id: string;
  company_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  is_primary: boolean;
  created_by?: string | null;
  updated_by?: string | null;
  /** Borrado lógico: null = activo. */
  deleted_at?: string | null;
}

export type CompaniesSortKey = "name" | "type" | "contacts" | "tax_id";
export type CompaniesSortDir = "asc" | "desc";

export function parseCompaniesSort(sp: { sort?: string; dir?: string }): {
  key: CompaniesSortKey;
  dir: CompaniesSortDir;
} {
  const key: CompaniesSortKey = COMPANIES_SORT_ALIASES[sp.sort ?? ""] ?? "name";
  if (sp.dir === "asc" || sp.dir === "desc") return { key, dir: sp.dir };
  // Texto ASC primero; conteos DESC primero (lo más relevante).
  return { key, dir: key === "contacts" ? "desc" : "asc" };
}

export async function listCrmCompanies(
  storeId: string,
  opts: { q?: string; kind?: CompanyKind | null; kinds?: readonly CompanyKind[]; sortKey?: CompaniesSortKey; sortDir?: CompaniesSortDir; page?: number; pageSize?: number; status?: CrmStatusFilter } = {},
): Promise<{ rows: CrmCompany[]; total: number }> {
  const db = getSupabase();
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(1, opts.page ?? 1);
  const sortKey = opts.sortKey ?? "name";
  const sortDir = opts.sortDir ?? (sortKey === "contacts" ? "desc" : "asc");
  const q = (opts.q ?? "").trim();
  // Multiselect prima sobre el single legacy. [] = ninguno (sin roundtrip).
  const kinds: readonly CompanyKind[] | undefined =
    opts.kinds ?? (opts.kind ? [opts.kind] : undefined);
  if (kinds !== undefined && kinds.length === 0) return { rows: [], total: 0 };

  // Vía rápida: un roundtrip con ranking + total exacto en Postgres.
  // p_kinds null = todos; array vacío no llega (corto arriba).
  const rpcKinds: string[] | null = kinds !== undefined ? [...kinds] : null;
  const rpc = await db.rpc("crm_search_companies", {
    p_store: storeId,
    p_q: q || null,
    p_kinds: rpcKinds,
    p_sort: sortKey,
    p_dir: sortDir,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
    p_status: opts.status ?? "active",
  });
  if (!rpc.error) {
    const data = (rpc.data ?? []) as Array<Record<string, unknown>>;
    const total = data.length > 0 ? Number(data[0].total ?? 0) : 0;
    return {
      rows: data.map((r) => ({
        id: String(r.id),
        store_id: String(r.store_id),
        name: String(r.name ?? ""),
        kind: (r.kind as CompanyKind | null) ?? null,
        tax_id: (r.tax_id as string | null) ?? null,
        domain: (r.domain as string | null) ?? null,
        email: (r.email as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        city: (r.city as string | null) ?? null,
        country: (r.country as string | null) ?? null,
        external_ref: (r.external_ref as string | null) ?? null,
        contacts_count: Number(r.contacts_count ?? 0),
        deleted_at: (r.deleted_at as string | null) ?? null,
      })),
      total: Number.isFinite(total) ? total : 0,
    };
  }
  if (!isSupabaseMissingFunction(rpc.error as { code?: string; message?: string })) {
    throw new Error(`CRM read: ${(rpc.error as { message?: string }).message ?? rpc.error}`);
  }
  return listCrmCompaniesLegacy(storeId, opts);
}

async function listCrmCompaniesLegacy(
  storeId: string,
  opts: { q?: string; kind?: CompanyKind | null; kinds?: readonly CompanyKind[]; sortKey?: CompaniesSortKey; sortDir?: CompaniesSortDir; page?: number; pageSize?: number; status?: CrmStatusFilter } = {},
): Promise<{ rows: CrmCompany[]; total: number }> {
  const db = getSupabase();
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(1, opts.page ?? 1);
  const sortKey = opts.sortKey ?? "name";
  const sortDir = opts.sortDir ?? (sortKey === "contacts" ? "desc" : "asc");
  const ascending = sortDir === "asc";
  const like = (() => {
    const q = (opts.q ?? "").trim();
    return q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
  })();
  // Total exacto para paginar (mismos filtros, sin orden ni rango).
  // La casa (kind IS NULL, red propia) nunca lista: no es contraparte.
  // Borrado lógico: activas por defecto.
  const status = opts.status ?? "active";
  const kinds: readonly CompanyKind[] | undefined =
    opts.kinds ?? (opts.kind ? [opts.kind] : undefined);
  if (kinds !== undefined && kinds.length === 0) return { rows: [], total: 0 };
  let countQuery = db.from("crm_companies").select("id", { count: "exact", head: true }).eq("store_id", storeId).not("kind", "is", null);
  if (status !== "all") countQuery = countQuery.filter("deleted_at", status === "active" ? "is" : "not.is", null);
  if (like) countQuery = countQuery.or(`name.ilike.${like},tax_id.ilike.${like},domain.ilike.${like},email.ilike.${like}`);
  if (kinds !== undefined) countQuery = countQuery.in("kind", [...kinds]);
  const { count, error: countError } = await countQuery;
  if (countError) throw new Error(`CRM read: ${countError.message}`);
  const total = count ?? 0;
  if (total === 0) return { rows: [], total };
  let query = db
    .from("crm_companies")
    .select("id,store_id,name,kind,tax_id,domain,email,phone,city,country,external_ref,deleted_at")
    .eq("store_id", storeId)
    .not("kind", "is", null);
  if (status !== "all") query = query.filter("deleted_at", status === "active" ? "is" : "not.is", null);
  if (like) query = query.or(`name.ilike.${like},tax_id.ilike.${like},domain.ilike.${like},email.ilike.${like}`);
  if (kinds !== undefined) query = query.in("kind", [...kinds]);
  // contactos es conteo calculado: se ordena en JS tras leer la página.
  if (sortKey === "name") query = query.order("name", { ascending });
  else if (sortKey === "type") query = query.order("kind", { ascending });
  else if (sortKey === "tax_id") query = query.order("tax_id", { ascending });
  else query = query.order("name", { ascending: true });
  const from = (page - 1) * pageSize;
  const { data, error } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(`CRM read: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const ids = rows.map((r) => String(r.id));
  const countBy = new Map<string, number>();
  if (ids.length > 0) {
    const { data: counts } = await db
      .from("crm_contacts")
      .select("company_id")
      .eq("store_id", storeId)
      .is("deleted_at", null)
      .in("company_id", ids);
    for (const c of (counts ?? []) as Array<Record<string, unknown>>) {
      const cid = String(c.company_id);
      countBy.set(cid, (countBy.get(cid) ?? 0) + 1);
    }
  }
  const out = rows.map((r) => ({
    id: String(r.id),
    store_id: String(r.store_id),
    name: String(r.name ?? ""),
    kind: (r.kind as CompanyKind | null) ?? null,
    tax_id: (r.tax_id as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    external_ref: (r.external_ref as string | null) ?? null,
    contacts_count: countBy.get(String(r.id)) ?? 0,
    deleted_at: (r.deleted_at as string | null) ?? null,
  }));
  if (sortKey === "contacts") {
    out.sort((a, b) => (ascending ? a.contacts_count - b.contacts_count : b.contacts_count - a.contacts_count));
  }
  return { rows: out, total };
}

export interface CrmContactListItem extends CrmContact {
  company_name: string | null;
}

/** Cargos distintos ya usados en la tienda (para autocomplete sin repetir). */
export async function listDistinctJobTitles(storeId: string, limit = 200): Promise<string[]> {
  const db = getSupabase();
  const capped = Math.min(Math.max(limit, 1), 500);
  const { data, error } = await db
    .from("crm_contacts")
    .select("job_title")
    .eq("store_id", storeId)
    .not("job_title", "is", null)
    .limit(capped);
  if (error) throw new Error(`CRM read: ${error.message}`);
  const seen = new Map<string, string>();
  for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
    const raw = typeof r.job_title === "string" ? r.job_title.trim() : "";
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!seen.has(key)) seen.set(key, raw);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "es")).slice(0, capped);
}

export async function listCrmContacts(
  storeId: string,
  opts: { q?: string; companyId?: string; limit?: number; status?: CrmStatusFilter } = {},
): Promise<{ rows: CrmContactListItem[]; total: number; truncated: boolean }> {
  const db = getSupabase();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const q = (opts.q ?? "").trim();
  const status = opts.status ?? "active";

  // Total exacto de la base (mismos filtros duros, sin texto): el RPC pagina
  // con límite, así que el total nunca sale de la muestra.
  // En modo activo sin empresa concreta, los contactos de empresas
  // archivadas no operan: se excluyen aquí igual que en el RPC
  // (los sueltos company_id null se conservan).
  let archivedCoIds: string[] = [];
  if (status === "active" && !opts.companyId) {
    const { data: arch } = await db
      .from("crm_companies")
      .select("id")
      .eq("store_id", storeId)
      .not("deleted_at", "is", null)
      .limit(1000);
    archivedCoIds = ((arch ?? []) as Array<Record<string, unknown>>).map((r) => String(r.id));
  }
  let countQuery = db
    .from("crm_contacts")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId);
  if (opts.companyId) countQuery = countQuery.eq("company_id", opts.companyId);
  if (status !== "all") countQuery = countQuery.filter("deleted_at", status === "active" ? "is" : "not.is", null);
  if (archivedCoIds.length > 0) {
    countQuery = countQuery.or(`company_id.is.null,company_id.not.in.(${archivedCoIds.join(",")})`);
  }
  const { count: baseTotal, error: countError } = await countQuery;
  if (countError) throw new Error(`CRM read: ${countError.message}`);

  // Vía rápida: un roundtrip que cruza persona + empresa en Postgres.
  const rpc = await db.rpc("crm_search_contacts", {
    p_store: storeId,
    p_q: q || null,
    p_company: opts.companyId ?? null,
    p_limit: limit,
    p_status: status,
  });
  if (!rpc.error) {
    const rows = ((rpc.data ?? []) as Array<Record<string, unknown>>).map((c) => ({
      id: String(c.id),
      store_id: String(c.store_id),
      company_id: (c.company_id as string | null) ?? null,
      first_name: (c.first_name as string | null) ?? null,
      last_name: (c.last_name as string | null) ?? null,
      email: (c.email as string | null) ?? null,
      phone: (c.phone as string | null) ?? null,
      job_title: (c.job_title as string | null) ?? null,
      is_primary: c.is_primary === true,
      created_by: (c.created_by as string | null) ?? null,
      updated_by: (c.updated_by as string | null) ?? null,
      company_name: (c.company_name as string | null) ?? null,
      deleted_at: (c.deleted_at as string | null) ?? null,
    }));
    // Sin texto el total es la base exacta; con texto vale sobre la muestra
    // y `truncated` lo declara (la UI pinta parcial, nunca total exacto).
    const truncated = rows.length >= limit;
    return { rows, total: q ? rows.length : (baseTotal ?? rows.length), truncated };
  }
  if (!isSupabaseMissingFunction(rpc.error as { code?: string; message?: string })) {
    throw new Error(`CRM read: ${(rpc.error as { message?: string }).message ?? rpc.error}`);
  }
  return listCrmContactsLegacy(storeId, opts, baseTotal ?? 0, archivedCoIds);
}

async function listCrmContactsLegacy(
  storeId: string,
  opts: { q?: string; companyId?: string; limit?: number; status?: CrmStatusFilter } = {},
  baseTotal = 0,
  archivedCoIds: string[] = [],
): Promise<{ rows: CrmContactListItem[]; total: number; truncated: boolean }> {
  const db = getSupabase();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const status = opts.status ?? "active";
  let query = db
    .from("crm_contacts")
    .select("id,store_id,company_id,first_name,last_name,email,phone,job_title,is_primary,created_by,updated_by,deleted_at,crm_companies!contacts_company_id_fkey(name)")
    .eq("store_id", storeId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (status !== "all") query = query.filter("deleted_at", status === "active" ? "is" : "not.is", null);
  if (opts.companyId) query = query.eq("company_id", opts.companyId);
  // Igual que el RPC y el conteo: en modo activo sin empresa concreta, fuera
  // contactos de empresas archivadas (los sueltos se conservan).
  if (status === "active" && !opts.companyId && archivedCoIds.length > 0) {
    query = query.or(`company_id.is.null,company_id.not.in.(${archivedCoIds.join(",")})`);
  }
  // El texto se filtra en JS (incluye nombre de empresa, que el `or` de
  // PostgREST no alcanza). Límite 200: escala suficiente para el CRM.
  const { data, error } = await query;
  if (error) throw new Error(`CRM read: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const companyIds = [...new Set(rows.map((r) => r.company_id as string | null).filter((v): v is string => !!v))];
  let names = new Map<string, string>();
  if (companyIds.length > 0) {
    const { data: cos, error: coerr } = await db.from("crm_companies").select("id,name").eq("store_id", storeId).in("id", companyIds);
    if (coerr) throw new Error(`CRM read: ${coerr.message}`);
    names = new Map(((cos ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), String(c.name ?? "")]));
  }
  const out = rows.map((c) => {
    const embedded = ((c.crm_companies ?? c.companies) as unknown as { name?: unknown } | null);
    const cid = (c.company_id as string | null) ?? null;
    return {
      id: String(c.id),
      store_id: String(c.store_id),
      company_id: cid,
      first_name: (c.first_name as string | null) ?? null,
      last_name: (c.last_name as string | null) ?? null,
      email: (c.email as string | null) ?? null,
      phone: (c.phone as string | null) ?? null,
      job_title: (c.job_title as string | null) ?? null,
      is_primary: c.is_primary === true,
      created_by: (c.created_by as string | null) ?? null,
      updated_by: (c.updated_by as string | null) ?? null,
      deleted_at: (c.deleted_at as string | null) ?? null,
      company_name: (embedded && typeof embedded.name === "string" ? embedded.name : null) ?? (cid ? (names.get(cid) ?? null) : null),
    };
  });
  // Sin join PostgREST (o si falló el embed), el nombre ya viene del mapa.
  // El filtro por empresa es exacto (company_id); el texto filtra personas.
  // El texto se filtra en JS sobre la muestra: si la muestra se llenó, puede
  // haber más filas fuera (truncated honesto, la UI pinta parcial).
  const q = (opts.q ?? "").trim();
  const sampleFilled = rows.length >= limit;
  const filtered = q
    ? out.filter((c) =>
        [c.first_name, c.last_name, c.email, c.job_title, c.company_name].some((v) =>
          (v ?? "").toLowerCase().includes(q.toLowerCase()),
        ),
      )
    : out;
  return {
    rows: filtered,
    total: q ? filtered.length : baseTotal || filtered.length,
    truncated: sampleFilled,
  };
}

export interface CrmCampaign {
  id: string;
  name: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  primary_contact_id: string | null;
}

export interface CompanyNetworkBrand {
  brand: string;
  ios: number;
}

export interface CompanyNetworkCompany {
  id: string;
  name: string;
  kind: CompanyKind | null;
  ios: number;
}

export interface CompanyNetwork {
  brands: CompanyNetworkBrand[];
  agencies: CompanyNetworkCompany[];
  advertisers: CompanyNetworkCompany[];
}

export async function getCrmCompany(
  storeId: string,
  companyId: string,
): Promise<{ company: Record<string, unknown>; contacts: CrmContact[]; campaigns: CrmCampaign[]; ios: Array<{ id: string; io_number: string; brand: string | null; status: string; advertiser_company_id: string | null; billing_company_id: string | null }>; network: CompanyNetwork } | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from("crm_companies")
    .select("*")
    .eq("store_id", storeId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(`CRM read: ${error.message}`);
  if (!data) return null;
  const [{ data: contacts }, { data: campaigns }, { data: ios }] = await Promise.all([
    db.from("crm_contacts").select("id,store_id,company_id,first_name,last_name,email,phone,job_title,is_primary,created_by,updated_by,deleted_at").eq("store_id", storeId).eq("company_id", companyId).order("is_primary", { ascending: false }).order("created_at", { ascending: true }),
    db.from("io_campaigns").select("id,name,status,starts_at,ends_at,primary_contact_id").eq("store_id", storeId).eq("advertiser_company_id", companyId).order("created_at", { ascending: false }).limit(50),
    db.from("io_orders").select("id,io_number,brand,status").eq("store_id", storeId).or(`advertiser_company_id.eq.${companyId},billing_company_id.eq.${companyId}`).order("created_at", { ascending: false }).limit(50),
  ]);
  return {
    company: data as Record<string, unknown>,
    contacts: ((contacts ?? []) as Array<Record<string, unknown>>).map((c) => ({
      id: String(c.id),
      store_id: String(c.store_id),
      company_id: (c.company_id as string | null) ?? null,
      first_name: (c.first_name as string | null) ?? null,
      last_name: (c.last_name as string | null) ?? null,
      email: (c.email as string | null) ?? null,
      phone: (c.phone as string | null) ?? null,
      job_title: (c.job_title as string | null) ?? null,
      is_primary: c.is_primary === true,
      deleted_at: (c.deleted_at as string | null) ?? null,
    })),
    campaigns: ((campaigns ?? []) as Array<Record<string, unknown>>).map((m) => ({
      id: String(m.id),
      name: String(m.name ?? ""),
      status: String(m.status ?? ""),
      starts_at: (m.starts_at as string | null) ?? null,
      ends_at: (m.ends_at as string | null) ?? null,
      primary_contact_id: (m.primary_contact_id as string | null) ?? null,
    })),
    ios: ((ios ?? []) as Array<Record<string, unknown>>).map((o) => ({
      id: String(o.id),
      io_number: String(o.io_number ?? ""),
      brand: (o.brand as string | null) ?? null,
      status: String(o.status ?? ""),
    })),
  };
}
