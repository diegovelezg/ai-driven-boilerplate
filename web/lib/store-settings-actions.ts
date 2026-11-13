"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { DEFAULT_SLOTS_PER_SCREEN, normalizeSlotsPerScreen } from "@/lib/tenant";
import { hasMinRole, isMemberRole } from "@/lib/roles";
import { createLogger } from "@/lib/log";

const log = createLogger("settings");

export interface StoreSettingsState {
  ok: boolean;
  message: string;
}

/** Cambia los espacios vendibles por pantalla y día (1 slot = 1 espacio).
 *  Solo admin/owner. Rango 1..100. */
export async function updateDefaultSlotsAction(input: {
  storeId: string;
  slots: number;
}): Promise<StoreSettingsState> {
  const slots = normalizeSlotsPerScreen(input.slots);
  if (!input.storeId) return { ok: false, message: "Falta tienda." };
  if (!Number.isSafeInteger(input.slots) || input.slots < 1 || input.slots > 100) {
    return { ok: false, message: `Espacios inválidos: entero 1..100 (recibido ${String(input.slots)}).` };
  }
  try {
    const { createServerSupabase } = await import("@/lib/supabase-server");
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, message: "No autenticado." };

    const db = getSupabase();
    const { data: caller } = await db
      .from("sys_memberships")
      .select("role")
      .eq("store_id", input.storeId)
      .eq("user_id", user.id)
      .maybeSingle();
    const callerRole = (caller as Record<string, unknown> | null)?.role;
    if (!isMemberRole(callerRole) || !hasMinRole(callerRole, "admin")) {
      return { ok: false, message: "Requiere rol admin o propietario." };
    }

    const { error } = await db
      .from("sys_stores")
      .update({ default_slots_per_screen: slots })
      .eq("id", input.storeId);
    if (error) { log.warn("updateDefaultSlotsAction", { fail: `DB write: ${error.message}` }); return { ok: false, message: `DB write: ${error.message}` }; }
    revalidatePath("/settings");
    return { ok: true, message: `Espacios por pantalla: ${slots} (default ${DEFAULT_SLOTS_PER_SCREEN}).` };
  } catch (e) {
    log.error("updateDefaultSlotsAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
