// Detección de customers duplicados por email (mismo email en >1 fila).
// Solo lectura: no modifica nada. Base para una futura fusión con aprobación.
import "server-only";
import { getSupabase } from "@/lib/supabase";
import { smartTitleCase } from "@/lib/text";

export interface DuplicateCustomerRow {
  dbId: string;
  externalId: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  companyName: string | null;
  customerType: string;
  source: string;
  ordersCount: number;
  totalSpent: number;
  currency: string | null;
  manualFields: string[];
  createdAt: string | null;
  lastOrderAt: string | null;
}

export interface DuplicateGroup {
  email: string;
  rows: DuplicateCustomerRow[];
}

const SELECT =
  "id,external_id,email,first_name,last_name,phone,company_name,customer_type,source,orders_count,total_spent,currency,manual_edits,external_created_at,last_order_at,country";

function toRow(r: Record<string, unknown>): DuplicateCustomerRow {
  return {
    dbId: String(r.id),
    externalId: (r.external_id as string) ?? null,
    firstName: smartTitleCase((r.first_name as string) ?? null),
    lastName: smartTitleCase((r.last_name as string) ?? null),
    phone: (r.phone as string) ?? null,
    companyName: smartTitleCase((r.company_name as string) ?? null),
    customerType: (r.customer_type as string) ?? "B2B",
    source: (r.source as string) ?? "ecommerce",
    ordersCount: Number(r.orders_count ?? 0),
    totalSpent: Number(r.total_spent ?? 0),
    currency: (r.currency as string) ?? null,
    manualFields: Object.keys((r.manual_edits as Record<string, unknown> | null) ?? {}),
    createdAt: (r.external_created_at as string) ?? null,
    lastOrderAt: (r.last_order_at as string) ?? null,
  };
}

async function loadAll(
  storeId: string,
): Promise<Array<Record<string, unknown>>> {
  const db = getSupabase();
  const all: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("customers").select(SELECT).eq("store_id", storeId).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`Duplicates read: ${error.message}`);
    all.push(...((data as Array<Record<string, unknown>>) ?? []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

/** Grupos de customers que comparten email (mismo email, >1 fila). */
export async function findDuplicateGroups(
  storeId: string,
): Promise<DuplicateGroup[]> {
  const all = await loadAll(storeId);
  const byEmail = new Map<string, DuplicateCustomerRow[]>();
  for (const r of all) {
    const email = String(r.email ?? "").trim().toLowerCase();
    if (!email) continue;
    const list = byEmail.get(email) ?? [];
    list.push(toRow(r));
    byEmail.set(email, list);
  }
  return [...byEmail.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([email, rows]) => ({ email, rows }))
    .sort((a, b) => b.rows.length - a.rows.length || a.email.localeCompare(b.email));
}

/** Conteo ligero (solo emails) para el badge del header. */
export async function countDuplicateEmails(
  storeId: string,
): Promise<number> {
  const db = getSupabase();
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("customers").select("email").eq("store_id", storeId).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`Duplicates read: ${error.message}`);
    for (const r of data ?? []) {
      const e = String(r.email ?? "").trim().toLowerCase();
      if (!e) continue;
      if (seen.has(e)) dup.add(e);
      else seen.add(e);
    }
    if (!data || data.length < 1000) break;
  }
  return dup.size;
}
