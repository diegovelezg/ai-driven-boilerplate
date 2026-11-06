// Guard compartido de las rutas `app/api/customers/[id]/*` + settings actions.
// Centraliza: exigir Supabase configurado, extraer `:id` (Next 16: promesa),
// exigir sesión (401) y membresía por tenant vía `merchant_users` (403).
// Multiuser por tenant: cualquier miembro ve todo su tenant; sin membresía
// no hay acceso (sin bypass legacy).
import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase";

/** Valida Supabase + `:id`. Devuelve el id o un `Response` de error listo para retornar.
 *  No autentica: las rutas de customer lo combinan con `requireCustomerStoreAccess`
 *  (auth + membresía en una sola llamada a `getUser`). */
export async function resolveRouteCustomerId(
  params: Promise<{ id: string }>,
): Promise<string | Response> {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }
  const { id } = await params;
  if (!id) return Response.json({ error: "Falta id." }, { status: 400 });
  return id;
}

/** Usuario autenticado o `Response` 401. Sin auth configurada (dev), null = legacy. */
export async function requireApiUser(): Promise<{ id: string; email: string | null } | Response | null> {
  let configured = false;
  try {
    const { isUserAuthConfigured } = await import("@/lib/supabase-server");
    configured = isUserAuthConfigured();
  } catch {
    configured = false;
  }
  if (!configured) return null;
  try {
    const { createServerSupabase } = await import("@/lib/supabase-server");
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    const user = data.user;
    if (!user) return Response.json({ error: "No autenticado." }, { status: 401 });
    return { id: user.id, email: user.email ?? null };
  } catch {
    return Response.json({ error: "No autenticado." }, { status: 401 });
  }
}

/** Roles del usuario por tienda vía service_role (bypassa RLS para el check). */
export async function userStoreRoles(userId: string): Promise<Map<string, string>> {
  try {
    const { getSupabase } = await import("@/lib/supabase");
    const { data } = await getSupabase()
      .from("merchant_users")
      .select("store_id,role")
      .eq("user_id", userId);
    const out = new Map<string, string>();
    for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
      out.set(String(r.store_id ?? ""), String(r.role ?? "seller"));
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Exige rol mínimo en `storeId` (para separar features por rol).
 * Devuelve null si ok, o `Response` 403 listo para retornar.
 */
export async function requireMinRole(
  storeId: string,
  user: { id: string; email: string | null } | null,
  need: "owner" | "admin" | "seller" | "viewer",
): Promise<Response | null> {
  if (!user) return null; // auth no configurada (dev): sin check
  if (!storeId) return Response.json({ error: "Falta store." }, { status: 400 });
  const { hasMinRole, isMemberRole } = await import("@/lib/roles");
  const roles = await userStoreRoles(user.id).catch(() => new Map<string, string>());
  const raw = roles.get(storeId);
  if (!raw || !isMemberRole(raw)) {
    return Response.json({ error: "Sin acceso a esta tienda." }, { status: 403 });
  }
  if (!hasMinRole(raw, need)) {
    return Response.json({ error: `Requiere rol ${need}.` }, { status: 403 });
  }
  return null;
}

/** Tiendas del usuario vía service_role (bypassa RLS para el check). */
export async function userStoreIds(userId: string): Promise<string[]> {
  try {
    const { getSupabase } = await import("@/lib/supabase");
    const { data } = await getSupabase()
      .from("merchant_users")
      .select("store_id")
      .eq("user_id", userId);
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => String(r.store_id ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Exige membresía a `storeId`. Sin membresías no hay acceso (403).
 * Devuelve null si ok, o `Response` 403 listo para retornar.
 */
export async function requireStoreMember(
  storeId: string,
  user: { id: string; email: string | null } | null,
): Promise<Response | null> {
  if (!user) return null; // auth no configurada (dev): sin check
  if (!storeId) return Response.json({ error: "Falta store." }, { status: 400 });
  const stores = await userStoreIds(user.id).catch(() => [] as string[]);
  if (stores.includes(storeId)) return null;
  return Response.json({ error: "Sin acceso a esta tienda." }, { status: 403 });
}

/**
 * Resuelve el `store_id` de un customer y exige membresía.
 * Devuelve el `storeId` o un `Response` (401/403/404) listo para retornar.
 */
export async function requireCustomerStoreAccess(customerId: string): Promise<string | Response> {
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  try {
    const { getSupabase } = await import("@/lib/supabase");
    const { data } = await getSupabase()
      .from("customers")
      .select("store_id")
      .eq("id", customerId)
      .maybeSingle();
    if (!data) return Response.json({ error: "Customer no encontrado." }, { status: 404 });
    const storeId = String((data as Record<string, unknown>).store_id ?? "");
    const denied = await requireStoreMember(storeId, auth);
    if (denied) return denied;
    return storeId;
  } catch {
    return Response.json({ error: "DB read failed." }, { status: 500 });
  }
}

/**
 * Exige sesión + membresía para una tienda dada (rutas con ?store= / body.storeId).
 * Devuelve el usuario o un `Response` (401/403) listo para retornar.
 */
export async function requireStoreAccess(
  storeId: string,
): Promise<{ id: string; email: string | null } | Response | null> {
  const auth = await requireApiUser();
  if (auth instanceof Response || auth === null) return auth;
  const denied = await requireStoreMember(storeId, auth);
  if (denied) return denied;
  return auth;
}
