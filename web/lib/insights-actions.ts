"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { listWallInsights, type WallInsight } from "@/lib/insights";

/** Muro del tenant para Hoy (server action: storeId siempre del servidor). */
export async function getWallAction(): Promise<WallInsight[]> {
  const { resolveTenantStoreAction, getMyStoreRole } = await import("@/lib/tenant");
  const t = await resolveTenantStoreAction().catch(() => ({ error: "Sin tienda." }) as const);
  if ("error" in t) return [];
  const storeId = t.storeId;
  let userId: string | null = null;
  let email: string | null = null;
  try {
    const { createServerSupabase } = await import("@/lib/supabase-server");
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
    email = data.user?.email ?? null;
  } catch {
    userId = null;
  }
  const role = await getMyStoreRole(storeId).catch(() => null);
  return listWallInsights(storeId, { userId, email, role }).catch(() => []);
}

/** Dismiss per-user (sys_insight_reads): nunca borra el post global. */
export async function dismissInsightAction(insightId: string): Promise<{ ok: boolean; message: string }> {
  if (!insightId) return { ok: false, message: "Falta insight." };
  try {
    const { createServerSupabase } = await import("@/lib/supabase-server");
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    if (!data.user) return { ok: false, message: "No autenticado." };
    const db = getSupabase();
    const { data: row } = await db.from("sys_insights").select("store_id").eq("id", insightId).maybeSingle();
    const storeId = String((row as Record<string, unknown> | null)?.store_id ?? "");
    if (!storeId) return { ok: false, message: "Insight no encontrado." };
    const { requireMyStoreAccess } = await import("@/lib/tenant");
    if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
      return { ok: false, message: "Sin acceso a esta tienda." };
    }
    const { error } = await db
      .from("sys_insight_reads")
      .upsert({ insight_id: insightId, user_id: data.user.id }, { onConflict: "insight_id,user_id" });
    if (error) return { ok: false, message: `DB write: ${error.message}` };
    revalidatePath("/");
    return { ok: true, message: "Descartado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
