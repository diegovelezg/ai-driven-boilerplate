// Tenant activo (SSOT). Orden: ?store=uuid validado en stores > conexión
// legacy (.data/connections.json) > primera tienda. Sin cookie todavía:
// la persistencia entre páginas llega en Fase 1 con el selector global.
//
// Multiuser por tenant: las lecturas SSR usan service_role (bypassa RLS),
// así que el aislamiento se enforcea en esta capa filtrando por membresía
// (`sys_memberships`). `listStores`/`getActiveStore` = sin filtro (workers y
// contextos sin sesión). `listMyStores`/`getMyActiveStore` = filtrado por el
// usuario actual vía cliente RLS (cualquier miembro del tenant ve todo el
// tenant, y solo sus tenants).
//
// SSOT (issue #8 P2): shop_currency siempre vía normalizeCurrency
// (nunca `String(x ?? 'PEN')` a mano); resolveTenantStoreAction unifica el
// resolve de server actions (antes copiado en crm/order/screens-actions).
import { getSupabase } from "@/lib/supabase";
import { normalizeCurrency } from "@/lib/currency";
import type { MemberRole } from "@/lib/roles";

export interface TenantStore {
  id: string;
  name: string | null;
  shop_currency: string;
  shop_country: string | null;
}

/** Lista tiendas ordenadas por creación. Si hay más de 50, valida el ?store=
 *  pedido por ID directo para no caer al tenant equivocado por ventana.
 *  `truncated` declara el corte (nunca total exacto silencioso). */
export async function listStores(
  requestedId?: string | null,
): Promise<{ stores: TenantStore[]; truncated: boolean; total: number }> {
  const db = getSupabase();
  const mapRow = (r: Record<string, unknown>): TenantStore => ({
    id: String(r.id),
    name: (r.name as string | null) ?? null,
    shop_currency: normalizeCurrency(r.shop_currency ?? "PEN"),
    shop_country: (r.shop_country as string | null) ?? null,
  });
  if (requestedId) {
    const { data: one } = await db
      .from("sys_stores")
      .select("id,name,shop_currency,shop_country")
      .eq("id", requestedId)
      .maybeSingle();
    if (one) return { stores: [mapRow(one as Record<string, unknown>)], truncated: false, total: 1 };
  }
  const { data, error, count } = await db
    .from("sys_stores")
    .select("id,name,shop_currency,shop_country", { count: "exact" })
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`Stores read: ${error.message}`);
  const total = count ?? 0;
  const truncated = total > 50;
  if (truncated) {
    const { createLogger } = await import("@/lib/log");
    createLogger("tenant")(`stores truncados a 50/${total}: validar ?store= por ID directo`);
  }
  return { stores: ((data ?? []) as Array<Record<string, unknown>>).map(mapRow), truncated, total };
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

/** Atajo: lista + resuelve. `truncated` declara el corte a 50 (la UI que
 *  liste tiendas debe pintarlo; el ?store= hostil se valida por ID directo). */
export async function getActiveStore(
  requestedId: string | null | undefined,
): Promise<{ stores: TenantStore[]; active: TenantStore | null; truncated: boolean }> {
  const { stores, truncated } = await listStores();
  if (requestedId && !stores.some((s) => s.id === requestedId)) {
    const direct = await listStores(requestedId).catch(() => null);
    for (const d of direct?.stores ?? []) {
      if (!stores.some((s) => s.id === d.id)) stores.push(d);
    }
  }
  if (stores.length === 0) return { stores, active: null, truncated };
  return { stores, active: await resolveActiveStore(stores, requestedId), truncated };
}

/** Nombre propio: sys_stores.name. Sin fallback: si está vacío es un
 *  dato por fijar en DB, no algo que la UI deba inventar. */
export function displayStoreName(s: { name: string | null }): string {
  return s.name?.trim() ?? "";
}

/** Anon-dev explícito: solo `ALLOW_ANON_DEV=1` fuera de producción permite el
 *  modo sin auth. Por defecto: fail-closed (sin sesión = sin acceso). */
export function isAnonDevAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.ALLOW_ANON_DEV === "1";
}

/** IDs de tiendas del usuario actual (vía RLS).
 *  null = anon-dev explícito (`ALLOW_ANON_DEV=1`, no-prod): sin scoping.
 *  [] = sin sesión / sin membresías / error RLS (fail-closed: sin acceso). */
export async function getMyStoreIds(): Promise<string[] | null> {
  let configured = false;
  try {
    const { isUserAuthConfigured } = await import("@/lib/supabase-server");
    configured = isUserAuthConfigured();
  } catch {
    return null;
  }
  if (!configured) return isAnonDevAllowed() ? null : [];
  try {
    const { createServerSupabase } = await import("@/lib/supabase-server");
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    const { data } = await supabase
      .from("sys_memberships")
      .select("store_id")
      .eq("user_id", user.id);
    return ((data ?? []) as Array<Record<string, unknown>>)
      .map((r) => String(r.store_id ?? ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** ¿El usuario actual pertenece a `storeId`? null = anon-dev explícito (permite).
 *  Sin auth configurada y sin bypass: false (fail-closed). */
export async function requireMyStoreAccess(storeId: string): Promise<boolean | null> {
  const ids = await getMyStoreIds().catch(() => [] as string[] | null);
  if (ids === null) return null;
  return ids.includes(storeId);
}

/** Roles del usuario actual por tienda (vía RLS). null = anon-dev explícito. */
export async function getMyStoreRoles(): Promise<Map<string, MemberRole> | null> {
  let configured = false;
  try {
    const { isUserAuthConfigured } = await import("@/lib/supabase-server");
    configured = isUserAuthConfigured();
  } catch {
    return null;
  }
  if (!configured) return isAnonDevAllowed() ? null : new Map();
  try {
    const { createServerSupabase } = await import("@/lib/supabase-server");
    const { isMemberRole } = await import("@/lib/roles");
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new Map();
    const { data } = await supabase
      .from("sys_memberships")
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

/** Rol del usuario actual en `storeId`. null = anon-dev o sin membresía (el caller deniega). */
export async function getMyStoreRole(storeId: string): Promise<MemberRole | null> {
  const roles = await getMyStoreRoles().catch(() => new Map());
  if (roles === null) return null;
  return roles.get(storeId) ?? null;
}

/** ¿El usuario actual alcanza el rol mínimo en `storeId`? null = anon-dev explícito.
 *  Sin auth y sin bypass: false (fail-closed). */
export async function requireMinRole(
  storeId: string,
  need: MemberRole,
): Promise<boolean | null> {
  const { hasMinRole } = await import("@/lib/roles");
  const roles = await getMyStoreRoles().catch(() => new Map());
  if (roles === null) return null; // anon-dev: permite
  const role = roles.get(storeId) ?? null;
  if (role === null) return false; // sin membresía: deniega
  return hasMinRole(role, need);
}

/** Membresía por userId explícito (service_role, bypassa RLS para el check).
 *  SSOT issue #4: `api/guard.ts` delega aquí — un solo chequeo de membresía,
 *  no dos stacks. */
export async function hasStoreMembership(userId: string, storeId: string): Promise<boolean> {
  if (!userId || !storeId) return false;
  try {
    const { data } = await getSupabase()
      .from("sys_memberships")
      .select("store_id")
      .eq("user_id", userId)
      .eq("store_id", storeId)
      .limit(1)
      .maybeSingle();
    return Boolean(data);
  } catch {
    return false;
  }
}

/** Tiendas visibles para el usuario actual. Fuera de membresía no se lista
 *  nada (el ?store= hostil se ignora aguas abajo en `getMyActiveStore`). */
export async function listMyStores(requestedId?: string | null): Promise<TenantStore[]> {
  const ids = await getMyStoreIds().catch(() => null);
  if (ids === null) return (await listStores(requestedId)).stores;
  if (ids.length === 0) return [];
  const db = getSupabase();
  if (requestedId) {
    if (!ids.includes(requestedId)) return listMyStores();
    const { data: one } = await db
      .from("sys_stores")
      .select("id,name,shop_currency,shop_country")
      .eq("id", requestedId)
      .maybeSingle();
    if (one) {
      const r = one as Record<string, unknown>;
      return [{
        id: String(r.id),
        name: (r.name as string | null) ?? null,
        shop_currency: normalizeCurrency(r.shop_currency ?? "PEN"),
        shop_country: (r.shop_country as string | null) ?? null,
      }];
    }
    return [];
  }
  const { data, error } = await db
    .from("sys_stores")
    .select("id,name,shop_currency,shop_country")
    .in("id", ids)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Stores read: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: (r.name as string | null) ?? null,
    shop_currency: normalizeCurrency(r.shop_currency ?? "PEN"),
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

/** SSOT server-action para resolver el tenant (issue #8 P2).
 *  Antes copiado en crm/order/screens-actions: misma secuencia
 *  resolveActiveStoreId → requireMyStoreAccess. Semántica tri-estado única: `requireMyStoreAccess`/`getMyStoreIds`/`getMyStoreRoles` retornan `null` SOLO en anon-dev explícito (`ALLOW_ANON_DEV=1`, no-prod); en todo lo demás, `false`/[] (fail-closed). Por eso los callers comparan `=== false` para denegar: `false` deniega, `null` permite (anon-dev). Nunca `!== true`, que denegaría el anon-dev. */
export async function resolveTenantStoreAction(need?: "seller" | "admin"): Promise<{ storeId: string } | { error: string }> {
  const storeId = await resolveActiveStoreId();
  if (!storeId) return { error: "Sin tienda." };
  if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
    return { error: "Sin acceso a esta tienda." };
  }
  if (need) {
    const allowed = await requireMinRole(storeId, need).catch(() => false);
    if (allowed === false) return { error: "Requiere rol vendedor o superior." };
  }
  return { storeId };
}
