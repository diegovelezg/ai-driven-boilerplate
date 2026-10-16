"use server";

import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { findDuplicateGroups } from "@/lib/duplicates";
import { mergeCustomers } from "@/lib/merge";

export interface MergeState {
  ok: boolean;
  message: string;
}

export interface MergeAllState extends MergeState {
  merged: number;
  failed: number;
  total: number;
}

/** Combina todos los grupos de duplicados en una pasada. Sigue aunque un caso falle. */
export async function mergeAllDuplicatesAction(): Promise<MergeAllState> {
  if (!isSupabaseConfigured())
    return { ok: false, message: "Supabase no configurado.", merged: 0, failed: 0, total: 0 };
  const conn = await readConnections();
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return { ok: false, message: "Tienda sin sincronizar.", merged: 0, failed: 0, total: 0 };
  try {
    const groups = await findDuplicateGroups(storeId);
    if (groups.length === 0)
      return { ok: true, message: "No hay casos pendientes.", merged: 0, failed: 0, total: 0 };
    let merged = 0;
    let failed = 0;
    let removed = 0;
    let movedOrders = 0;
    const errors: string[] = [];
    for (const g of groups) {
      try {
        const r = await mergeCustomers(
          storeId,
          g.rows.map((r) => r.dbId),
        );
        merged += 1;
        removed += r.removed;
        movedOrders += r.movedOrders;
      } catch (e) {
        failed += 1;
        if (errors.length < 3) errors.push(`${g.email}: ${e instanceof Error ? e.message : "error"}`);
      }
    }
    revalidatePath("/customers/duplicates");
    revalidatePath("/customers");
    if (merged === 0)
      return {
        ok: false,
        message: `No se pudo combinar ningún caso (${failed} fallo${failed === 1 ? "" : "s"}). ${errors.join(" · ")}`,
        merged,
        failed,
        total: groups.length,
      };
    const tail = failed > 0 ? ` · ${failed} fallo${failed === 1 ? "" : "s"}: ${errors.join(" · ")}` : "";
    return {
      ok: failed === 0,
      message: `Combinados ${merged}/${groups.length} casos · ${removed} ficha${removed === 1 ? "" : "s"} eliminada${removed === 1 ? "" : "s"} · ${movedOrders} ${movedOrders === 1 ? "orden" : "órdenes"} movida${movedOrders === 1 ? "" : "s"}.${tail}`,
      merged,
      failed,
      total: groups.length,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "error",
      merged: 0,
      failed: 0,
      total: 0,
    };
  }
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
