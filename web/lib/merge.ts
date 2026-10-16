// Fusión de customers duplicados (mismo email). Mueve órdenes, preserva ediciones
// manuales y registra un alias para que el sync de Medusa no recree los combinados.
import "server-only";
import { getSupabase } from "@/lib/supabase";
import { groupTotalsByCurrency } from "@/lib/medusa";

export interface MergeResult {
  removed: number;
  movedOrders: number;
}

interface Row {
  id: string;
  external_id: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  company_name: string | null;
  customer_type: string | null;
  manual_edits: Record<string, unknown> | null;
  orders_count: number;
}

/** Combina 2+ fichas en una canónica. Elige canónica: con external_id → más órdenes → más ediciones. */
export async function mergeCustomers(storeId: string, dbIds: string[]): Promise<MergeResult> {
  const db = getSupabase();
  const unique = [...new Set(dbIds)];
  if (unique.length < 2) throw new Error("Se necesitan al menos 2 fichas para combinar.");

  const { data, error } = await db
    .from("customers")
    .select(
      "id,external_id,first_name,last_name,phone,company_name,customer_type,manual_edits,orders_count",
    )
    .eq("store_id", storeId)
    .in("id", unique);
  if (error) throw new Error(`Merge read: ${error.message}`);
  const rows = (data as Row[] | null) ?? [];
  if (rows.length < 2) throw new Error("Fichas no encontradas.");

  const withExt = rows.filter((r) => r.external_id);
  const pool = (withExt.length ? withExt : rows).slice();
  pool.sort(
    (a, b) =>
      Number(b.orders_count ?? 0) - Number(a.orders_count ?? 0) ||
      Object.keys(b.manual_edits ?? {}).length - Object.keys(a.manual_edits ?? {}).length,
  );
  const canonical = pool[0];
  const merged = rows.filter((r) => r.id !== canonical.id);
  const mergedIds = merged.map((r) => r.id);

  // Ediciones manuales: gana la canónica; se completa con las demás.
  const manual: Record<string, unknown> = { ...(canonical.manual_edits ?? {}) };
  for (const m of merged) {
    for (const [k, v] of Object.entries(m.manual_edits ?? {})) {
      if (!(k in manual)) manual[k] = v;
    }
  }
  const patch: Record<string, unknown> = { manual_edits: manual };
  for (const f of ["first_name", "last_name", "phone", "company_name"] as const) {
    if (!canonical[f]) {
      const src = merged.find((m) => m[f]);
      if (src) patch[f] = src[f];
    }
  }

  // Mover órdenes a la canónica.
  const { data: moved } = await db
    .from("orders")
    .update({ customer_id: canonical.id })
    .in("customer_id", mergedIds)
    .select("id");
  const movedOrders = moved?.length ?? 0;

  // Recalcular stats de la canónica desde sus órdenes.
  const { data: ords } = await db
    .from("orders")
    .select("total_amount,currency,placed_at")
    .eq("customer_id", canonical.id);
  const orderRows = (ords as Array<Record<string, unknown>> | null) ?? [];
  const totals = groupTotalsByCurrency(
    orderRows.map((o) => ({
      amount: Number(o.total_amount ?? 0),
      currency: (o.currency as string) ?? null,
    })),
  );
  const primary = totals[0];
  const lastOrderAt = orderRows.reduce<string | null>((acc, o) => {
    const p = o.placed_at as string | null;
    return p && (!acc || p > acc) ? p : acc;
  }, null);
  patch.orders_count = totals.reduce((s, t) => s + t.ordersCount, 0);
  patch.total_spent = primary?.totalSpent ?? 0;
  patch.currency = primary?.currency ?? null;
  patch.last_order_at = lastOrderAt;

  const { error: upErr } = await db.from("customers").update(patch).eq("id", canonical.id);
  if (upErr) throw new Error(`Merge update: ${upErr.message}`);

  // Alias para que el sync no recree los combinados.
  const canonicalExt = canonical.external_id;
  if (canonicalExt) {
    const aliases = merged
      .filter((m) => m.external_id && m.external_id !== canonicalExt)
      .map((m) => ({
        store_id: storeId,
        merged_external_id: m.external_id as string,
        canonical_external_id: canonicalExt,
      }));
    if (aliases.length > 0) {
      const { error: aErr } = await db
        .from("customer_aliases")
        .upsert(aliases, { onConflict: "store_id,merged_external_id" });
      if (aErr) throw new Error(`Merge alias: ${aErr.message}`);
    }
  }

  // Borrar filas combinadas.
  const { error: delErr } = await db.from("customers").delete().in("id", mergedIds);
  if (delErr) throw new Error(`Merge delete: ${delErr.message}`);

  return { removed: mergedIds.length, movedOrders };
}
