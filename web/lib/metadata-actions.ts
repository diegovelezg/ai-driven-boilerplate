"use server";

import { revalidatePath } from "next/cache";
import {
  getMetadataMap,
  saveMetadataMap,
  scanMetadataKeys,
  suggestContentKey,
  inferMetadataRoles,
  type MetadataKeyInfo,
  type MetadataMap,
  type MetadataRoles,
} from "@/lib/metadata-map";

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

/** Escanea keys + sugerencia para el formulario (lectura). */
export async function scanMetadataAction(
  storeId: string,
): Promise<
  | { ok: true; keys: MetadataKeyInfo[]; saved: MetadataMap | null; suggested: string | null; suggestedRoles: MetadataRoles }
  | { ok: false; message: string }
> {
  try {
    const denied = await denyStore(storeId);
    if (denied) return { ok: false, message: denied };
    const [keys, saved] = await Promise.all([
      scanMetadataKeys(storeId),
      getMetadataMap(storeId).catch(() => null),
    ]);
    return { ok: true, keys, saved, suggested: suggestContentKey(keys), suggestedRoles: inferMetadataRoles(keys) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "No se pudo escanear." };
  }
}

/** Guarda la key de contenido (valida: 0-1). */
export async function saveMetadataMapAction(
  storeId: string,
  map: unknown,
): Promise<{ ok: boolean; message: string }> {
  try {
    const denied = await denyStore(storeId);
    if (denied) return { ok: false, message: denied };
    await saveMetadataMap(storeId, map);
    revalidatePath("/settings");
    return { ok: true, message: "Mapeo guardado. El motor lo usa desde la próxima lectura." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "No se pudo guardar." };
  }
}
