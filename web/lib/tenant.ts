// Tenant activo (SSOT). Orden: ?store=uuid validado en stores > conexión
// legacy (.data/connections.json) > primera tienda. Sin cookie todavía:
// la persistencia entre páginas llega en Fase 1 con el selector global.
import { resolveStoreId } from "@/lib/customers-db";
import { readConnections } from "@/lib/store";
import { getSupabase } from "@/lib/supabase";

export interface TenantStore {
  id: string;
  name: string | null;
  shop_url: string;
  platform: string;
  shop_currency: string;
}

/** Lista tiendas ordenadas por creación (límite 50, mismo que Overview/Chat). */
export async function listStores(): Promise<TenantStore[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("stores")
    .select("id,name,shop_url,platform,shop_currency")
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`Stores read: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: (r.name as string | null) ?? null,
    shop_url: String(r.shop_url ?? ""),
    platform: String(r.platform ?? ""),
    shop_currency: String(r.shop_currency ?? "PEN"),
  }));
}

/** Fallback legacy: la única conexión guardada en .data/connections.json. */
export async function getLegacyStoreId(): Promise<string | null> {
  const conn = await readConnections();
  if (!conn.medusaUrl) return null;
  return resolveStoreId(conn.medusaUrl).catch(() => null);
}

/** Valida ?store= contra la lista; si no existe, null (el caller aplica fallback). */
export function pickRequestedStore(
  stores: TenantStore[],
  requestedId: string | null | undefined,
): TenantStore | null {
  if (!requestedId) return null;
  return stores.find((s) => s.id === requestedId) ?? null;
}

/** Resuelve el tenant activo con el orden canónico. Nunca null si hay tiendas. */
export async function resolveActiveStore(
  stores: TenantStore[],
  requestedId: string | null | undefined,
): Promise<TenantStore> {
  const picked = pickRequestedStore(stores, requestedId);
  if (picked) return picked;
  const viaConn = await getLegacyStoreId();
  if (viaConn) {
    const viaStore = stores.find((s) => s.id === viaConn);
    if (viaStore) return viaStore;
  }
  return stores[0];
}

/** Atajo: lista + resuelve. Devuelve tiendas vacías si aún no hay sync. */
export async function getActiveStore(
  requestedId: string | null | undefined,
): Promise<{ stores: TenantStore[]; active: TenantStore | null }> {
  const stores = await listStores();
  if (stores.length === 0) return { stores, active: null };
  return { stores, active: await resolveActiveStore(stores, requestedId) };
}

/** Nombre propio: stores.name, si no deriva del host. Nunca la URL cruda. */
export function displayStoreName(s: { name: string | null; shop_url: string }): string {
  if (s.name?.trim()) return s.name.trim();
  try {
    const host = new URL(s.shop_url).hostname.replace(/^(www|api)\./, "");
    const first = host.split(".")[0];
    if (first) return first.charAt(0).toUpperCase() + first.slice(1);
  } catch {
    // shop_url sin protocolo: se muestra tal cual
  }
  return s.shop_url;
}

/** Añade/preserva ?store= en un href interno (para InsightStrip/CustomersView). */
export function withStoreParam(href: string, storeId: string): string {
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}store=${encodeURIComponent(storeId)}`;
}
