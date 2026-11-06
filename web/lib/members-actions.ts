"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { hasMinRole, isMemberRole, type MemberRole } from "@/lib/roles";

export interface MembersState {
  ok: boolean;
  message: string;
}

/** Cambia el rol de un miembro. Solo admin+: admin no toca owners ni crea owners. */
export async function updateMemberRoleAction(input: {
  storeId: string;
  userId: string;
  role: MemberRole;
}): Promise<MembersState> {
  if (!input.storeId || !input.userId) return { ok: false, message: "Falta tienda o usuario." };
  if (!isMemberRole(input.role)) return { ok: false, message: "Rol inválido." };
  try {
    const { createServerSupabase } = await import("@/lib/supabase-server");
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, message: "No autenticado." };

    const db = getSupabase();
    const { data: caller } = await db
      .from("merchant_users")
      .select("role")
      .eq("store_id", input.storeId)
      .eq("user_id", user.id)
      .maybeSingle();
    const callerRole = (caller as Record<string, unknown> | null)?.role;
    if (!isMemberRole(callerRole) || !hasMinRole(callerRole, "admin")) {
      return { ok: false, message: "Requiere rol admin o propietario." };
    }
    const { data: target } = await db
      .from("merchant_users")
      .select("role")
      .eq("store_id", input.storeId)
      .eq("user_id", input.userId)
      .maybeSingle();
    if (!target) return { ok: false, message: "Miembro no encontrado en esta tienda." };
    const targetRole = (target as Record<string, unknown>).role;
    if (!isMemberRole(targetRole)) return { ok: false, message: "Rol actual inválido." };
    // Admin no gestiona owners (ni los degrada ni crea nuevos).
    if (callerRole === "admin" && (targetRole === "owner" || input.role === "owner")) {
      return { ok: false, message: "Solo el propietario gestiona propietarios." };
    }
    // Nunca quedarse sin owner.
    if (targetRole === "owner" && input.role !== "owner") {
      const { count } = await db
        .from("merchant_users")
        .select("user_id", { count: "exact", head: true })
        .eq("store_id", input.storeId)
        .eq("role", "owner");
      if ((count ?? 0) <= 1) {
        return { ok: false, message: "No puedes quitar al único propietario." };
      }
    }
    if (targetRole === input.role) return { ok: true, message: "Sin cambios." };
    const { error } = await db
      .from("merchant_users")
      .update({ role: input.role })
      .eq("store_id", input.storeId)
      .eq("user_id", input.userId);
    if (error) return { ok: false, message: `DB write: ${error.message}` };
    revalidatePath("/settings");
    return { ok: true, message: "Rol actualizado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
