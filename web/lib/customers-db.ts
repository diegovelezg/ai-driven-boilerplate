// Lecturas de customers desde Supabase (source of truth para la vista).
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { normalizeShopUrl } from "@/lib/sync";
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

function toCanonicalCustomer(r: Record<string, unknown>): CanonicalCustomer {
  const currency = (r.currency as string) ?? null;
  const ordersCount = Number(r.orders_count ?? 0);
  const totalSpent = Number(r.total_spent ?? 0);
  return {
    id: String(r.external_id ?? r.id),
    email: String(r.email ?? ""),
    firstName: (r.first_name as string) ?? null,
    lastName: (r.last_name as string) ?? null,
    phone: (r.phone as string) ?? null,
    companyName: (r.company_name as string) ?? null,
    createdAt: (r.external_created_at as string) ?? null,
    ordersCount,
    totalSpent,
    currency,
    totalsByCurrency: currency ? [{ currency, ordersCount, totalSpent }] : [],
  };
}

export interface DbCustomersPage {
  rows: CanonicalCustomer[];
  totalCount: number;
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
    case "company":
      query = query.order("company_name", { ascending });
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
  const term = q.trim();
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
    query = query.or(
      `email.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},phone.ilike.${like}`,
    );
  }
  const { data, count, error } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(`DB read: ${error.message}`);
  return {
    rows: ((data as Array<Record<string, unknown>>) ?? []).map(toCanonicalCustomer),
    totalCount: count ?? 0,
  };
}
