// Tenant activo (SSOT). Orden: ?store=uuid validado en stores > conexión
// legacy (.data/connections.json) > primera tienda. Sin cookie todavía:
// la persistencia entre páginas llega en Fase 1 con el selector global.
//
// Multiuser por tenant: las lecturas SSR usan service_role (bypassa RLS),
// así que el aislamiento se enforcea en esta capa filtrando por membresía
// (`merchant_users`). `listStores`/`getActiveStore` = sin filtro (workers y
// contextos sin sesión). `listMyStores`/`getMyActiveStore` = filtrado por el
// usuario actual vía cliente RLS (cualquier miembro del tenant ve todo el
// tenant, y solo sus tenants).
import { getSupabase } from "@/lib/supabase";
import type { MemberRole } from "@/lib/roles";

export interface TenantStore {
  id: string;
  name: string | null;
  shop_url: string;
  platform: string;
  shop_currency: string;
  shop_country: string | null;
}

/** Lista tiendas ordenadas por creación. Si hay más de 50, valida el ?store=
 *  pedido por ID directo para no caer al tenant equivocado por ventana. */
export async function listStores(requestedId?: string | null): Promise<TenantStore[]> {
  const db = getSupabase();
  if (requestedId) {
    const { data: one } = await db
      .from("stores")
      .select("id,name,shop_url,platform,shop_currency,shop_country")
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
        shop_country: (r.shop_country as string | null) ?? null,
      }];
    }
  }
  const { data, error, count } = await db
    .from("stores")
    .select("id,name,shop_url,platform,shop_currency,shop_country", { count: "exact" })
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
    shop_country: (r.shop_country as string | null) ?? null,
  }));
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
async function resolveActiveStore(
  stores: TenantStore[],
  requestedId: string | null | undefined,
): Promise<TenantStore> {
  const picked = pickRequestedStore(stores, requestedId);
  if (picked) return picked;
  return stores[0];
}

/** Atajo: lista + resuelve. */
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

/** IDs de tiendas del usuario actual (vía RLS: `merchant_users_self_read`).
 *  null = auth no configurada (dev local sin login: sin scoping).
 *  [] = autenticado sin membresías (sin acceso a ningún tenant). */
export async function getMyStoreIds(): Promise<string[] | null> {
  let configured = false;
  try {
    const { isUserAuthConfigured } = await import("@/lib/supabase-server");
    configured = isUserAuthConfigured();
  } catch {
    return null;
  }
  if (!configured) return null;
  try {
    const { createServerSupabase } = await import("@/lib/supabase-server");
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    const { data } = await supabase
      .from("merchant_users")
      .select("store_id")
      .eq("user_id", user.id);
    return ((data ?? []) as Array<Record<string, unknown>>)
      .map((r) => String(r.store_id ?? ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** ¿El usuario actual pertenece a `storeId`? null = sin auth (dev: permite). */
export async function requireMyStoreAccess(storeId: string): Promise<boolean | null> {
  const ids = await getMyStoreIds().catch(() => null);
  if (ids === null) return null;
  return ids.includes(storeId);
}

/** Roles del usuario actual por tienda (vía RLS). null = sin auth (dev: sin scoping). */
export async function getMyStoreRoles(): Promise<Map<string, MemberRole> | null> {
  let configured = false;
  try {
    const { isUserAuthConfigured } = await import("@/lib/supabase-server");
    configured = isUserAuthConfigured();
  } catch {
    return null;
  }
  if (!configured) return null;
  try {
    const { createServerSupabase } = await import("@/lib/supabase-server");
    const { isMemberRole } = await import("@/lib/roles");
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new Map();
    const { data } = await supabase
      .from("merchant_users")
      .select("store_id,role")
      .eq("user_id", user.id);
    const out = new Map<string, MemberRole>();
    for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
      const role = r.role;
      if (!isMemberRole(role)) continue;
      out.set(String(r.store_id ?? ""), role);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Rol del usuario actual en `storeId`. null = sin auth (dev: permite todo). */
export async function getMyStoreRole(storeId: string): Promise<MemberRole | null> {
  const roles = await getMyStoreRoles().catch(() => null);
  if (roles === null) return null;
  return roles.get(storeId) ?? null;
}

/** ¿El usuario actual alcanza el rol mínimo en `storeId`? null = sin auth (dev: permite). */
export async function requireMinRole(
  storeId: string,
  need: MemberRole,
): Promise<boolean | null> {
  const { hasMinRole } = await import("@/lib/roles");
  const roles = await getMyStoreRoles().catch(() => null);
  if (roles === null) return null; // sin auth: permite
  const role = roles.get(storeId) ?? null;
  if (role === null) return false; // sin membresía: deniega
  return hasMinRole(role, need);
}

/** Tiendas visibles para el usuario actual. Fuera de membresía no se lista
 *  nada (el ?store= hostil se ignora aguas abajo en `getMyActiveStore`). */
export async function listMyStores(requestedId?: string | null): Promise<TenantStore[]> {
  const ids = await getMyStoreIds().catch(() => null);
  if (ids === null) return listStores(requestedId);
  if (ids.length === 0) return [];
  const db = getSupabase();
  if (requestedId) {
    if (!ids.includes(requestedId)) return listMyStores();
    const { data: one } = await db
      .from("stores")
      .select("id,name,shop_url,platform,shop_currency,shop_country")
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
        shop_country: (r.shop_country as string | null) ?? null,
      }];
    }
    return [];
  }
  const { data, error } = await db
    .from("stores")
    .select("id,name,shop_url,platform,shop_currency,shop_country")
    .in("id", ids)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Stores read: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: (r.name as string | null) ?? null,
    shop_url: String(r.shop_url ?? ""),
    platform: String(r.platform ?? ""),
    shop_currency: String(r.shop_currency ?? "PEN"),
    shop_country: (r.shop_country as string | null) ?? null,
  }));
}

/** `getActiveStore` filtrado por membresía: ?store= fuera del tenant se
 *  ignora (fallback a la primera tienda del usuario, nunca a la ajena). */
export async function getMyActiveStore(
  requestedId: string | null | undefined,
): Promise<{ stores: TenantStore[]; active: TenantStore | null }> {
  const stores = await listMyStores();
  if (stores.length === 0) return { stores, active: null };
  const picked = requestedId ? (stores.find((s) => s.id === requestedId) ?? null) : null;
  if (picked) return { stores, active: picked };
  return { stores, active: stores[0] };
}

/** Atajo server-action: id del tenant activo (primera tienda del usuario). */
export async function resolveActiveStoreId(requestedId?: string | null): Promise<string | null> {
  try {
    const { active } = await getMyActiveStore(requestedId ?? null);
    return active?.id ?? null;
  } catch {
    return null;
  }
}
