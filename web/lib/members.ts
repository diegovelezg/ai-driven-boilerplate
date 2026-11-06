// Miembros del tenant (lecturas service_role). Escrituras en members-actions.ts.
import { getSupabase } from "@/lib/supabase";
import { isMemberRole, type MemberRole } from "@/lib/roles";

export interface StoreMember {
  user_id: string;
  email: string | null;
  role: MemberRole;
  created_at: string | null;
}

/** Miembros de la tienda ordenados por antigüedad. Email best-effort (admin API). */
export async function listStoreMembers(storeId: string): Promise<StoreMember[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("merchant_users")
    .select("user_id,role,created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Members read: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  // Emails vía Admin API (service_role). Si falla, se muestra el user_id.
  let emailById = new Map<string, string>();
  try {
    const { data: users } = await db.auth.admin.listUsers({ perPage: 100 });
    emailById = new Map(
      ((users?.users ?? []) as Array<{ id: string; email?: string | null }>).map((u) => [u.id, u.email ?? ""]),
    );
  } catch {
    emailById = new Map();
  }
  return rows
    .map((r) => {
      const uid = String(r.user_id ?? "");
      if (!uid) return null;
      const role = r.role;
      return {
        user_id: uid,
        email: emailById.get(uid) ?? null,
        role: isMemberRole(role) ? role : ("seller" as MemberRole),
        created_at: (r.created_at as string | null) ?? null,
      };
    })
    .filter((m): m is StoreMember => m !== null);
}
