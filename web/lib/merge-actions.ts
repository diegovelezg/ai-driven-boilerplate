"use server";

import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { mergeCustomers } from "@/lib/merge";

export interface MergeState {
  ok: boolean;
  message: string;
}

export async function mergeCustomersAction(dbIds: string[]): Promise<MergeState> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Supabase no configurado." };
  if (!Array.isArray(dbIds) || dbIds.length < 2) {
    return { ok: false, message: "Se necesitan al menos 2 fichas." };
  }
  const conn = await readConnections();
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return { ok: false, message: "Tienda sin sincronizar." };
  try {
    const r = await mergeCustomers(storeId, dbIds);
    revalidatePath("/customers/duplicates");
    revalidatePath("/customers");
    return {
      ok: true,
      message: `Combinadas ${r.removed + 1} fichas · ${r.movedOrders} órdenes movidas.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "error" };
  }
}
