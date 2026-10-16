// Lecturas de customers desde Supabase (source of truth para la vista).
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { normalizeShopUrl } from "@/lib/sync";
import { domainFromEmail } from "@/lib/domains";
import { smartTitleCase } from "@/lib/text";
import type { CanonicalCustomer } from "@/lib/medusa";

export async function resolveStoreId(medusaUrl: string): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const { data } = await getSupabase()
    .from("stores")
    .select("id")
    .eq("platform", "medusa")
    .eq("shop_url", normalizeShopUrl(medusaUrl))
    .maybeSingle();
  return (data?.id as string) ?? null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Valor efectivo: override manual ?? base Medusa ("gana lo local"). */
function eff(overrides: Record<string, unknown>, key: string, base: unknown): string | null {
  return str(overrides[key]) ?? (base as string) ?? null;
}

export type ManualField = "first_name" | "last_name" | "phone" | "company_name" | "customer_type";
export const MANUAL_FIELDS: readonly ManualField[] = [
  "first_name",
  "last_name",
  "phone",
  "company_name",
  "customer_type",
];

/** Customer listo para UI editable: valores efectivos + base Medusa + qué está overrideado. */
export interface EditableCustomer extends CanonicalCustomer {
  /** UUID de la fila en Supabase (para writes). `id` sigue siendo el external_id. */
  dbId: string;
  customerType: string;
  /** companyName proviene del enriquecimiento (no de Medusa ni edición manual). */
  companyNameEnriched: boolean;
  base: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    companyName: string | null;
    customerType: string;
  };
  manualFields: ManualField[];
}

export function toEditableCustomer(
  r: Record<string, unknown>,
  enrichedByDomain: Map<string, string> = new Map(),
): EditableCustomer {
  const currency = (r.currency as string) ?? null;
  const ordersCount = Number(r.orders_count ?? 0);
  const totalSpent = Number(r.total_spent ?? 0);
  const overrides =
    (r.manual_edits as Record<string, unknown> | null) ?? {};
  const baseCustomerType = (r.customer_type as string) ?? "B2C";
  const manualFields = MANUAL_FIELDS.filter((k) => str(overrides[k]) !== null);
  // Empresa: edición manual > Medusa > enriquecimiento (por dominio).
  const overrideCompany = str(overrides["company_name"]);
  const baseCompany = (r.company_name as string) ?? null;
  const enrichedCompany =
    enrichedByDomain.get(domainFromEmail(String(r.email ?? ""))) ?? null;
  const companyName = overrideCompany ?? baseCompany ?? enrichedCompany;
  const companyNameEnriched = !overrideCompany && !baseCompany && !!enrichedCompany;
  return {
    id: String(r.external_id ?? r.id),
    dbId: String(r.id),
    email: String(r.email ?? ""),
    firstName: smartTitleCase(eff(overrides, "first_name", r.first_name)),
    lastName: smartTitleCase(eff(overrides, "last_name", r.last_name)),
    phone: eff(overrides, "phone", r.phone),
    companyName: smartTitleCase(companyName),
    companyNameEnriched,
    customerType: eff(overrides, "customer_type", baseCustomerType) ?? "B2C",
    createdAt: (r.external_created_at as string) ?? null,
    ordersCount,
    totalSpent,
    currency,
    totalsByCurrency: currency ? [{ currency, ordersCount, totalSpent }] : [],
    base: {
      firstName: (r.first_name as string) ?? null,
      lastName: (r.last_name as string) ?? null,
      phone: (r.phone as string) ?? null,
      companyName: (r.company_name as string) ?? null,
      customerType: baseCustomerType,
    },
    manualFields,
  };
}

export interface DbCustomersPage {
  rows: EditableCustomer[];
  totalCount: number;
}

export interface PendingCustomer {
  customer: EditableCustomer;
  inputHash: string;
}

/**
 * Customers pendientes de (re)procesamiento LLM: nunca procesados o con
 * cambios desde el último procesamiento. `needs_processing` lo mantiene el
 * trigger `customers_input_hash`; esta query no necesita comparar hashes.
 */
export async function queryPendingCustomers(
  storeId: string,
  limit = 50,
): Promise<PendingCustomer[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("customers")
    .select("*")
    .eq("store_id", storeId)
    .eq("needs_processing", true)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`DB read: ${error.message}`);
  return ((data as Array<Record<string, unknown>>) ?? []).map((r) => ({
    customer: toEditableCustomer(r),
    inputHash: String(r.input_hash ?? ""),
  }));
}

/**
 * Marca un customer como procesado. Update condicional: solo escribe si nadie
 * lo tocó en el medio (input_hash intacto); si devuelve false, re-leer.
 * `patch` = columnas de resultado del worker (se guardan en el mismo UPDATE).
 */
export async function markCustomerProcessed(
  id: string,
  inputHash: string,
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const db = getSupabase();
  const { data, error } = await db
    .from("customers")
    .update({
      ...patch,
      processed_hash: inputHash,
      processed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("input_hash", inputHash)
    .select("id");
  if (error) throw new Error(`DB write: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export type CustomersSortKey = "email" | "name" | "phone" | "company" | "orders" | "total";
export type CustomersSortDir = "asc" | "desc";
export interface CustomersSort {
  key: CustomersSortKey;
  dir: CustomersSortDir;
}

const SORT_KEYS: readonly CustomersSortKey[] = [
  "email",
  "name",
  "phone",
  "company",
  "orders",
  "total",
];

/** Valida sort/dir de searchParams; default estable email/asc (orden previo). */
export function parseCustomersSort(sp: { sort?: string; dir?: string }): CustomersSort {
  const key = SORT_KEYS.includes(sp.sort as CustomersSortKey)
    ? (sp.sort as CustomersSortKey)
    : "email";
  const dir = sp.dir === "desc" ? "desc" : "asc";
  return { key, dir };
}

/** company_name enriquecido por dominio (para poblar "Empresa" si Medusa no la trae). */
async function loadEnrichedByDomain(
  db: ReturnType<typeof getSupabase>,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const domains = [
    ...new Set(rows.map((r) => domainFromEmail(String(r.email ?? ""))).filter(Boolean)),
  ];
  if (domains.length === 0) return map;
  const { data } = await db.from("domains").select("domain,company_name").in("domain", domains);
  for (const d of data ?? []) {
    const name = (d.company_name as string) ?? null;
    if (name) map.set(String(d.domain), name);
  }
  return map;
}

export async function queryStoreCustomers(
  storeId: string,
  q: string,
  page: number,
  pageSize: number,
  sort: CustomersSort = { key: "email", dir: "asc" },
): Promise<DbCustomersPage> {
  const db = getSupabase();
  const from = (page - 1) * pageSize;
  const ascending = sort.dir === "asc";
  const term = q.trim();
  const like = term ? `%${term.replace(/[%_\\]/g, "\\$&")}%` : null;
  const searchOr = `email.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},phone.ilike.${like}`;

  // "Empresa" se ordena por el nombre EFECTIVO (manual > Medusa > enriquecido),
  // que puede venir del enriquecimiento por dominio → se resuelve en JS.
  if (sort.key === "company") {
    const all: Array<Record<string, unknown>> = [];
    for (let off = 0; ; off += 1000) {
      let bq = db.from("customers").select("*").eq("store_id", storeId);
      if (like) bq = bq.or(searchOr);
      const { data, error } = await bq.range(off, off + 999);
      if (error) throw new Error(`DB read: ${error.message}`);
      all.push(...((data as Array<Record<string, unknown>>) ?? []));
      if (!data || data.length < 1000) break;
    }
    const enriched = await loadEnrichedByDomain(db, all);
    const rows = all.map((r) => toEditableCustomer(r, enriched));
    rows.sort((a, b) => {
      const av = (a.companyName ?? "").trim();
      const bv = (b.companyName ?? "").trim();
      if (!av && !bv) return 0;
      if (!av) return 1; // vacíos al final
      if (!bv) return -1;
      const c = av.localeCompare(bv, "es", { sensitivity: "base" });
      return ascending ? c : -c;
    });
    return { rows: rows.slice(from, from + pageSize), totalCount: rows.length };
  }

  let query = db.from("customers").select("*", { count: "exact" }).eq("store_id", storeId);
  switch (sort.key) {
    case "email":
      query = query.order("email", { ascending });
      break;
    case "name":
      query = query
        .order("first_name", { ascending })
        .order("last_name", { ascending });
      break;
    case "phone":
      query = query.order("phone", { ascending });
      break;
    case "orders":
      query = query.order("orders_count", { ascending });
      break;
    case "total":
      query = query.order("total_spent", { ascending });
      break;
  }
  // Desempate estable para paginar sin filas duplicadas/ausentes.
  if (sort.key !== "email") query = query.order("email", { ascending: true });
  if (like) query = query.or(searchOr);
  const { data, count, error } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(`DB read: ${error.message}`);

  const raw = (data as Array<Record<string, unknown>>) ?? [];
  const enrichedByDomain = await loadEnrichedByDomain(db, raw);
  return {
    rows: raw.map((r) => toEditableCustomer(r, enrichedByDomain)),
    totalCount: count ?? 0,
  };
}
