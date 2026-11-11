// Lecturas CRM (service_role, como customers-db). Escrituras en crm-actions.ts.
import { getSupabase, isSupabaseMissingFunction } from "@/lib/supabase";
import { COMPANIES_SORT_ALIASES } from "@/lib/sort";
import type { CompanyKind, CrmStatusFilter } from "@/lib/crm";

export interface CrmCompany {
  id: string;
  store_id: string;
  name: string;
  /** Razón social / nombre legal (name = nombre comercial). Null solo en legados. */
  legal_name: string | null;
  kind: CompanyKind | null;
  tax_id: string | null;
  domain: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  external_ref: string | null;
  /** Vertical IAB 2.0 (IAB1–IAB24). SSOT en lib/advertiser-categories. */
  category_iab: string | null;
  /** Subtipo de proveedor (solo kind = 'proveedor'). */
  provider_type: string | null;
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
        legal_name: (r.legal_name as string | null) ?? null,
        kind: (r.kind as CompanyKind | null) ?? null,
        tax_id: (r.tax_id as string | null) ?? null,
        domain: (r.domain as string | null) ?? null,
        email: (r.email as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        city: (r.city as string | null) ?? null,
        country: (r.country as string | null) ?? null,
        external_ref: (r.external_ref as string | null) ?? null,
        category_iab: (r.category_iab as string | null) ?? null,
        provider_type: (r.provider_type as string | null) ?? null,
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
  if (like) countQuery = countQuery.or(`name.ilike.${like},legal_name.ilike.${like},tax_id.ilike.${like},domain.ilike.${like},email.ilike.${like}`);
  if (kinds !== undefined) countQuery = countQuery.in("kind", [...kinds]);
  const { count, error: countError } = await countQuery;
  if (countError) throw new Error(`CRM read: ${countError.message}`);
  const total = count ?? 0;
  if (total === 0) return { rows: [], total };
  let query = db
    .from("crm_companies")
    .select("id,store_id,name,legal_name,kind,tax_id,domain,email,phone,city,country,external_ref,category_iab,provider_type,deleted_at")
    .eq("store_id", storeId)
    .not("kind", "is", null);
  if (status !== "all") query = query.filter("deleted_at", status === "active" ? "is" : "not.is", null);
  if (like) query = query.or(`name.ilike.${like},legal_name.ilike.${like},tax_id.ilike.${like},domain.ilike.${like},email.ilike.${like}`);
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
    legal_name: (r.legal_name as string | null) ?? null,
    kind: (r.kind as CompanyKind | null) ?? null,
    tax_id: (r.tax_id as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    external_ref: (r.external_ref as string | null) ?? null,
    category_iab: (r.category_iab as string | null) ?? null,
    provider_type: (r.provider_type as string | null) ?? null,
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
  opts: { q?: string; companyId?: string; limit?: number; status?: CrmStatusFilter; kinds?: readonly CompanyKind[] } = {},
): Promise<{ rows: CrmContactListItem[]; total: number; truncated: boolean }> {
  const db = getSupabase();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const q = (opts.q ?? "").trim();
  const status = opts.status ?? "active";
  // Multiselect igual que empresas ([] = ninguno, sin roundtrip).
  // undefined = todos (sin filtro). El default de la vista
  // (agencia + anunciante) lo pone el caller vía parseCompanyKinds.
  const kinds: readonly CompanyKind[] | undefined = opts.kinds;
  if (kinds !== undefined && kinds.length === 0) return { rows: [], total: 0, truncated: false };
  const rpcKinds: string[] | null = kinds !== undefined ? [...kinds] : null;
  // Empresa concreta + filtro de tipo: si su tipo no matchea, vacío directo.
  if (opts.companyId && rpcKinds !== null) {
    const { data: co } = await db
      .from("crm_companies")
      .select("kind")
      .eq("store_id", storeId)
      .eq("id", opts.companyId)
      .maybeSingle();
    const k = (co as Record<string, unknown> | null)?.kind;
    if (typeof k !== "string" || !rpcKinds.includes(k)) return { rows: [], total: 0, truncated: false };
  }

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
  // Filtro de tipo para el conteo: sueltos (company_id null) se conservan.
  // Se resuelve en un solo `.or()` (llamarlo dos veces pisa el anterior).
  let kindIds: string[] | null = null;
  if (rpcKinds !== null && !opts.companyId) {
    const { data: kindCos } = await db
      .from("crm_companies")
      .select("id")
      .eq("store_id", storeId)
      .in("kind", rpcKinds)
      .limit(2000);
    kindIds = ((kindCos ?? []) as Array<Record<string, unknown>>).map((r) => String(r.id));
  }
  if (kindIds !== null && kindIds.length === 0) {
    countQuery = countQuery.is("company_id", null);
  } else if (archivedCoIds.length > 0 && kindIds !== null) {
    countQuery = countQuery.or(
      `company_id.is.null,and(company_id.in.(${kindIds.join(",")}),company_id.not.in.(${archivedCoIds.join(",")}))`,
    );
  } else if (archivedCoIds.length > 0) {
    countQuery = countQuery.or(`company_id.is.null,company_id.not.in.(${archivedCoIds.join(",")})`);
  } else if (kindIds !== null) {
    countQuery = countQuery.or(`company_id.is.null,company_id.in.(${kindIds.join(",")})`);
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
    p_kinds: rpcKinds,
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
  opts: { q?: string; companyId?: string; limit?: number; status?: CrmStatusFilter; kinds?: readonly CompanyKind[] } = {},
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
  const kindBy = new Map<string, string>();
  if (companyIds.length > 0) {
    const { data: cos, error: coerr } = await db.from("crm_companies").select("id,name,kind").eq("store_id", storeId).in("id", companyIds);
    if (coerr) throw new Error(`CRM read: ${coerr.message}`);
    names = new Map(((cos ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), String(c.name ?? "")]));
    for (const c of ((cos ?? []) as Array<Record<string, unknown>>)) {
      if (typeof c.kind === "string") kindBy.set(String(c.id), c.kind);
    }
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
  // Tipo de empresa (multiselect igual que empresas): sueltos se conservan.
  const q = (opts.q ?? "").trim();
  const kindSet = opts.kinds !== undefined ? new Set<string>(opts.kinds) : null;
  const sampleFilled = rows.length >= limit;
  const filtered = out.filter((c) => {
    if (kindSet && c.company_id !== null) {
      const k = kindBy.get(c.company_id);
      if (!k || !kindSet.has(k)) return false;
    }
    if (!q) return true;
    return [c.first_name, c.last_name, c.email, c.job_title, c.company_name].some((v) =>
      (v ?? "").toLowerCase().includes(q.toLowerCase()),
    );
  });
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
  /** true cuando existe vínculo explícito (pre-OI o sembrado desde OI). */
  explicit: boolean;
  origin: "manual" | "oi" | null;
}

export interface CompanyNetwork {
  brands: CompanyNetworkBrand[];
  agencies: CompanyNetworkCompany[];
  advertisers: CompanyNetworkCompany[];
}

export interface ContactAccount {
  contact_id: string;
  advertiser_company_id: string;
}

/** Un contacto de agencia que atiende a esta empresa (vista anunciante). */
export interface IncomingAccount {
  contact_id: string;
  agency_company_id: string;
}

/** Contacto de una agencia vinculada (para gestionar atendidos). */
export interface AgencyTeamContact {
  id: string;
  agency_company_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  is_primary: boolean;
}

export async function getCrmCompany(
  storeId: string,
  companyId: string,
): Promise<{ company: Record<string, unknown>; contacts: CrmContact[]; campaigns: CrmCampaign[]; ios: Array<{ id: string; io_number: string; brand: string | null; status: string; advertiser_company_id: string | null; billing_company_id: string | null }>; network: CompanyNetwork; contact_accounts: ContactAccount[]; incoming_accounts: IncomingAccount[]; agency_team: AgencyTeamContact[] } | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from("crm_companies")
    .select("*")
    .eq("store_id", storeId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(`CRM read: ${error.message}`);
  if (!data) return null;
  const [{ data: contacts }, { data: campaigns }, { data: iosAll }, { data: linksAll }, { data: accountsAll }, { data: incomingAll }] = await Promise.all([
    db.from("crm_contacts").select("id,store_id,company_id,first_name,last_name,email,phone,job_title,is_primary,created_by,updated_by,deleted_at").eq("store_id", storeId).eq("company_id", companyId).order("is_primary", { ascending: false }).order("created_at", { ascending: true }),
    db.from("io_campaigns").select("id,name,status,starts_at,ends_at,primary_contact_id").eq("store_id", storeId).eq("advertiser_company_id", companyId).order("created_at", { ascending: false }).limit(50),
    // Historial para la red comercial (drawer Vínculos): hasta 500 IOs donde
    // participa (como anunciante o facturación). La marca es metadato del
    // pedido (io_orders.brand), la contraparte se resuelve abajo.
    db.from("io_orders").select("id,io_number,brand,status,advertiser_company_id,billing_company_id").eq("store_id", storeId).or(`advertiser_company_id.eq.${companyId},billing_company_id.eq.${companyId}`).order("created_at", { ascending: false }).limit(500),
    // Vínculos explícitos pre-OI (una dirección por rol; se fusionan abajo).
    db.from("crm_company_links").select("agency_company_id,advertiser_company_id,origin").eq("store_id", storeId).or(`agency_company_id.eq.${companyId},advertiser_company_id.eq.${companyId}`).limit(500),
    // Cuentas que atiende cada contacto de esta empresa (solo agencias declaran).
    db.from("crm_contact_accounts").select("contact_id,advertiser_company_id").eq("store_id", storeId).eq("agency_company_id", companyId).limit(500),
    // Vista anunciante: contactos de agencia que atienden a esta empresa.
    db.from("crm_contact_accounts").select("contact_id,agency_company_id").eq("store_id", storeId).eq("advertiser_company_id", companyId).limit(500),
  ]);
  const iosRows = ((iosAll ?? []) as Array<Record<string, unknown>>).map((o) => ({
    id: String(o.id),
    io_number: String(o.io_number ?? ""),
    brand: (o.brand as string | null) ?? null,
    status: String(o.status ?? ""),
    advertiser_company_id: (o.advertiser_company_id as string | null) ?? null,
    billing_company_id: (o.billing_company_id as string | null) ?? null,
  }));
  // Red derivada: marcas (distinct normalizado) + contrapartes por rol.
  // Directa (advertiser=billing) no cuenta como agencia ni anunciante.
  const brandCount = new Map<string, { brand: string; ios: number }>();
  const agencyIds = new Map<string, number>();
  const advertiserIds = new Map<string, number>();
  for (const o of iosRows) {
    const b = (o.brand ?? "").trim();
    if (b) {
      const k = b.toUpperCase();
      const prev = brandCount.get(k);
      if (prev) prev.ios += 1;
      else brandCount.set(k, { brand: b, ios: 1 });
    }
    const adv = o.advertiser_company_id;
    const bill = o.billing_company_id;
    if (adv === companyId && bill && bill !== companyId) {
      agencyIds.set(bill, (agencyIds.get(bill) ?? 0) + 1);
    }
    if (bill === companyId && adv && adv !== companyId) {
      advertiserIds.set(adv, (advertiserIds.get(adv) ?? 0) + 1);
    }
  }
  const counterpartIds = [...new Set([...agencyIds.keys(), ...advertiserIds.keys()])];
  // Explícitos: el rol depende del lado que ocupa la empresa actual.
  const explicitAgencyIds = new Map<string, "manual" | "oi">();
  const explicitAdvertiserIds = new Map<string, "manual" | "oi">();
  for (const l of ((linksAll ?? []) as Array<Record<string, unknown>>)) {
    const ag = typeof l.agency_company_id === "string" ? l.agency_company_id : null;
    const adv = typeof l.advertiser_company_id === "string" ? l.advertiser_company_id : null;
    const origin = l.origin === "oi" ? "oi" : "manual";
    if (!ag || !adv) continue;
    if (adv === companyId && ag !== companyId) {
      const prev = explicitAgencyIds.get(ag);
      if (prev !== "manual") explicitAgencyIds.set(ag, origin);
    }
    if (ag === companyId && adv !== companyId) {
      const prev = explicitAdvertiserIds.get(adv);
      if (prev !== "manual") explicitAdvertiserIds.set(adv, origin);
    }
  }
  for (const id of [...explicitAgencyIds.keys(), ...explicitAdvertiserIds.keys()]) {
    if (!counterpartIds.includes(id)) counterpartIds.push(id);
  }
  const nameBy = new Map<string, { name: string; kind: CompanyKind | null }>();
  if (counterpartIds.length > 0) {
    const { data: counterparties } = await db
      .from("crm_companies")
      .select("id,name,kind")
      .eq("store_id", storeId)
      .in("id", counterpartIds);
    for (const c of ((counterparties ?? []) as Array<Record<string, unknown>>)) {
      const id = String(c.id);
      nameBy.set(id, {
        name: String(c.name ?? "—"),
        kind: (c.kind as CompanyKind | null) ?? null,
      });
    }
  }
  const toCompanies = (
    m: Map<string, number>,
    explicit: Map<string, "manual" | "oi">,
  ): CompanyNetworkCompany[] =>
    [...new Set([...m.keys(), ...explicit.keys()])]
      .map((id) => ({
        id,
        name: nameBy.get(id)?.name ?? "—",
        kind: nameBy.get(id)?.kind ?? null,
        ios: m.get(id) ?? 0,
        explicit: explicit.has(id),
        origin: explicit.get(id) ?? null,
      }))
      .sort((a, b) => b.ios - a.ios || a.name.localeCompare(b.name, "es"));
  const network: CompanyNetwork = {
    brands: [...brandCount.values()].sort((a, b) => b.ios - a.ios || a.brand.localeCompare(b.brand, "es")),
    agencies: toCompanies(agencyIds, explicitAgencyIds),
    advertisers: toCompanies(advertiserIds, explicitAdvertiserIds),
  };
  // Ficha: solo las 50 recientes (comportamiento previo intacto).
  const ios = iosRows.slice(0, 50);
  const contact_accounts: ContactAccount[] = ((accountsAll ?? []) as Array<Record<string, unknown>>)
    .filter((a) => typeof a.contact_id === "string" && typeof a.advertiser_company_id === "string")
    .map((a) => ({ contact_id: String(a.contact_id), advertiser_company_id: String(a.advertiser_company_id) }));
  const incoming_accounts: IncomingAccount[] = ((incomingAll ?? []) as Array<Record<string, unknown>>)
    .filter((a) => typeof a.contact_id === "string" && typeof a.agency_company_id === "string")
    .map((a) => ({ contact_id: String(a.contact_id), agency_company_id: String(a.agency_company_id) }));
  // Vista anunciante: equipo de las agencias vinculadas para gestionar
  // quiénes lo atienden (una sola query, hasta 500 contactos).
  let agency_team: AgencyTeamContact[] = [];
  const companyKind = (data as Record<string, unknown>).kind;
  if (companyKind === "anunciante") {
    const linkedAgencyIds = [...new Set([
      ...explicitAgencyIds.keys(),
      ...incoming_accounts.map((a) => a.agency_company_id),
    ])];
    if (linkedAgencyIds.length > 0) {
      const { data: team } = await db
        .from("crm_contacts")
        .select("id,company_id,first_name,last_name,email,phone,job_title,is_primary")
        .eq("store_id", storeId)
        .is("deleted_at", null)
        .in("company_id", linkedAgencyIds)
        .order("created_at", { ascending: true })
        .limit(500);
      agency_team = ((team ?? []) as Array<Record<string, unknown>>)
        .filter((c) => typeof c.id === "string" && typeof c.company_id === "string")
        .map((c) => ({
          id: String(c.id),
          agency_company_id: String(c.company_id),
          first_name: (c.first_name as string | null) ?? null,
          last_name: (c.last_name as string | null) ?? null,
          email: (c.email as string | null) ?? null,
          phone: (c.phone as string | null) ?? null,
          job_title: (c.job_title as string | null) ?? null,
          is_primary: c.is_primary === true,
        }));
    }
  }
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
    ios,
    network,
    contact_accounts,
    incoming_accounts,
    agency_team,
  };
}
