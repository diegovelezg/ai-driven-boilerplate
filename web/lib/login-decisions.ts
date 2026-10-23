// Log explícito de decisiones de sync en login (debug multi-tenant).
// Best-effort y nunca rompe el login: si la tabla no existe (DB sin migrar)
// o falla el insert, se ignora (el `log()` a consola/archivo sigue).
// Leer últimos N por tienda:
//   select created_at, sync, reason, has_running, last_sync_done_at, omit_detail
//   from login_sync_decisions where store_id = '<uuid>' order by created_at desc limit 20;
import type { LoginSyncReason } from "@/lib/login-sync";
import type { LoginPlan } from "@/lib/login-plan";

export interface LoginDecision {
  storeId: string | null;
  userId: string | null;
  sync: boolean;
  reason: LoginSyncReason | string;
  hasRunning: boolean;
  lastSyncDoneAt: string | null;
  omitDetail?: string | null;
}

/** Persiste una decisión (service_role, bypasa RLS). Nunca lanza. */
export async function recordLoginDecision(d: LoginDecision): Promise<void> {
  try {
    const { getSupabase, isSupabaseConfigured } = await import("@/lib/supabase");
    if (!isSupabaseConfigured()) return;
    const db = getSupabase();
    const { error } = await db
      .from("login_sync_decisions")
      .insert({
        store_id: d.storeId,
        user_id: d.userId,
        sync: d.sync,
        reason: d.reason,
        has_running: d.hasRunning,
        last_sync_done_at: d.lastSyncDoneAt,
        omit_detail: d.omitDetail ?? null,
      });
    if (error) throw error;
    // Retención 90 días (best-effort, misma llamada): una fila por login sin
    // purga es tracking indefinido. A esta escala el costo es nulo.
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
    await db.from("login_sync_decisions").delete().lt("created_at", cutoff);
  } catch (e) {
    // Best-effort: el login sigue aunque el log falle. Pero no tragar en
    // silencio errores de programación (columna mal escrita, tipos): van a
    // consola, donde el dev los ve sin romper el login.
    console.warn("[login-decisions]", e instanceof Error ? e.message : e);
  }
}

/**
 * Construye el registro a persistir desde el plan (pura, testeable sin BD).
 * `sync` = full decidido, NO ejecutado: `runSyncOnce` puede perder el slot
 * atómico después (lo cubre el cron) y la rama morning-only registra
 * `sync:false` aunque el morning sí corra. Para "¿corrió algo?" leer
 * `background_runs`; esta tabla responde "¿qué decidió el login y por qué?".
 */
export function buildLoginRecord(
  plan: LoginPlan,
  targetStoreId: string | null,
  userId: string | null,
): LoginDecision {
  if (plan.omitReason) {
    return {
      storeId: targetStoreId,
      userId,
      sync: false,
      reason: plan.omitReason,
      hasRunning: plan.running,
      lastSyncDoneAt: plan.lastSyncDoneAt,
    };
  }
  return {
    storeId: plan.storeId ?? plan.probeStoreId ?? targetStoreId,
    userId,
    // storeId null (ensureStore falló) = nada va a correr: sync:false aunque
    // la decisión fuera sync:true.
    sync: plan.decision.sync && !plan.running && plan.storeId != null,
    reason: plan.decision.reason,
    hasRunning: plan.running,
    lastSyncDoneAt: plan.lastSyncDoneAt,
  };
}
