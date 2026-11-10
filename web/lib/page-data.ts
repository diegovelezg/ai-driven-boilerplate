import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";

/** Datos + estado del gate de una page del dashboard. */
export interface PageData<T> {
  data: T;
  connected: boolean;
  dbReady: boolean;
  error: string | null;
}

/** Gate común de las pages del dashboard: DB configurada + tienda activa +
 *  membresía (fail-closed, sin oráculo: fuera del tenant = "Sin acceso").
 *  `load` recibe el storeId validado; `fallback` pinta el vacío cuando el
 *  gate no abre o la carga falla. Misma semántica que el bloque que reemplaza
 *  en cada page (mismo orden, mismos mensajes). */
export async function loadPageData<T>(
  load: (storeId: string) => Promise<T>,
  fallback: T,
): Promise<PageData<T>> {
  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);
  if (!connected || !dbReady) return { data: fallback, connected, dbReady, error: null };
  try {
    const storeId = activeStoreId!;
    if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
      return { data: fallback, connected, dbReady, error: "Sin acceso a esta tienda." };
    }
    return { data: await load(storeId), connected, dbReady, error: null };
  } catch (e) {
    return {
      data: fallback,
      connected,
      dbReady,
      error: e instanceof Error ? e.message : "No se pudieron cargar los datos.",
    };
  }
}
