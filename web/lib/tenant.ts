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

/** Lista tiendas ordenadas por creación. Si hay más de 50, valida el ?store=
 *  pedido por ID directo para no caer al tenant equivocado por ventana. */
export async function listStores(requestedId?: string | null): Promise<TenantStore[]> {
  const db = getSupabase();
  if (requestedId) {
    const { data: one } = await db
      .from("stores")
      .select("id,name,shop_url,platform,shop_currency")
      .eq("id", requestedId)
      .maybeSingle();
    if (one) {
      const r = one as Record<string, unknown>;
      return [{
        id: String(r.id),
        name: (r.name as string | null) ?? null,
        shop_url: String(r.shop_url ?? ""),
        platform: String(r.platform ?? ""),
        shop_currency: String(r.shop_currency ?? "PEN"),
      }];
    }
  }
  const { data, error, count } = await db
    .from("stores")
    .select("id,name,shop_url,platform,shop_currency", { count: "exact" })
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`Stores read: ${error.message}`);
  if ((count ?? 0) > 50) {
    const { createLogger } = await import("@/lib/log");
    createLogger("tenant")(`stores truncados a 50/${count}: validar ?store= por ID directo`);
  }
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

/** Atajo: lista + resuelve. Devuelve tiendas vacías si aún no hay sync.
 *  Ventana 50 para el switcher + validación por ID directo si ?store= cae
 *  fuera (merge, no reemplazo: el switcher sigue viendo la lista). */
export async function getActiveStore(
  requestedId: string | null | undefined,
): Promise<{ stores: TenantStore[]; active: TenantStore | null }> {
  const stores = await listStores();
  if (requestedId && !stores.some((s) => s.id === requestedId)) {
    const direct = await listStores(requestedId).catch(() => [] as TenantStore[]);
    for (const d of direct) {
      if (!stores.some((s) => s.id === d.id)) stores.push(d);
    }
  }
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
