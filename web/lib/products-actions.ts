"use server";

import { revalidatePath } from "next/cache";
import { setProductActiveOverride } from "@/lib/products";

/** Membresía por tenant (patrón repo: lib/api/guard). Legacy/dev sin auth: permite. */
async function denyStore(storeId: string): Promise<string | null> {
  try {
    const { requireStoreAccess } = await import("@/lib/api/guard");
    const res = await requireStoreAccess(storeId);
    return res instanceof Response ? "Sin acceso a esta tienda." : null;
  } catch {
    return null;
  }
}

/** Toggle activo/inactivo por producto (override manual; null = seguir plataforma). */
export async function setProductActiveAction(
  storeId: string,
  productId: string,
  active: boolean | null,
): Promise<{ ok: boolean; message: string }> {
  try {
    const denied = await denyStore(storeId);
    if (denied) return { ok: false, message: denied };
    await setProductActiveOverride(storeId, productId, active);
    revalidatePath("/products");
    return { ok: true, message: "Producto actualizado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "No se pudo actualizar." };
  }
}
