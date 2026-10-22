"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { ensureStore } from "@/lib/sync";
import { hasRunningRun } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { shouldSyncOnLogin } from "@/lib/login-sync";

const log = createLogger("sync");

export interface AuthState {
  ok: boolean;
  message: string;
}

/** Login solo con email+password (sin signup público: el merchant lo crea Studio/CLI). */
export async function signInAction(_prev: AuthState | null, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "").trim();
  if (!email || !password) return { ok: false, message: "Falta email o password." };
  let supabase;
  try {
    supabase = await createServerSupabase();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Supabase no configurado." };
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Diagnóstico: el mensaje genérico ocultaba la causa (API key, URL, red).
    console.error("[login] signInWithPassword:", error.status, error.message);
    return { ok: false, message: `Credenciales inválidas. (${error.message})` };
  }
  // Cada inicio de sesión dispara sync ecommerce → BD en background
  // (no bloquea el login si falla; se omite si hay run en curso).
  scheduleSyncOnLogin();
  if (next.startsWith("/") && !next.startsWith("//")) redirect(next);
  // Multiuser: el destino es la primera membresía del usuario (RLS ya filtra
  // a sus tenants; cualquier miembro ve todo su tenant).
  const { data } = await supabase
    .from("merchant_users")
    .select("store_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const storeId = data?.store_id as string | undefined;
  redirect(storeId ? `/?store=${storeId}` : "/");
}

export async function signOutAction(): Promise<void> {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Login liviano: ejecución directa en `after()`, sin cola.
 * Best-effort: nunca rompe el login; omite si no hay conexión, si Supabase
 * no está configurado o si ya hay un run en curso. Throttle de 15 min +
 * slot atómico de `runSyncOnce`: logins concurrentes no duplican fulls.
 */
function scheduleSyncOnLogin(): void {
  after(async () => {
    try {
      const conn = await readConnections();
      const supabaseConfigured = isSupabaseConfigured();
      // Primera lectura barata para decidir sin tocar BD.
      const probeStoreId = supabaseConfigured
        ? await resolveStoreId(conn.medusaUrl).catch(() => null)
        : null;
      // hasRunningRun exige storeId; sin tienda aún no hay run en curso.
      const running = probeStoreId ? await hasRunningRun(probeStoreId) : false;
      // Throttle: si hubo sync done hace <15 min, no se repite el full.
      const { getLastFinishedAt } = await import("@/lib/background");
      const lastSyncDoneAt = probeStoreId
        ? await getLastFinishedAt(probeStoreId, "sync").catch(() => null)
        : null;
      const decision = shouldSyncOnLogin(conn, {
        supabaseConfigured,
        hasRunningRun: running,
        lastSyncDoneAt,
      });
      const storeId =
        probeStoreId ??
        (decision.sync
          ? await ensureStore(conn.medusaUrl, conn.medusaToken).catch(() => null)
          : null);
      if (!storeId) {
        log(`login sync omitido (${decision.reason})`);
        return;
      }
      // Sin cola: ejecución directa. `runSyncOnce` reclama slot atómico
      // (null si el cron/manual lo cubre) y encadena la mañana.
      try {
        if (decision.sync && !running) {
          const { runSyncOnce } = await import("@/lib/sync-runner");
          await runSyncOnce(storeId, conn.medusaUrl, {
            version: conn.medusaVersion || "v1",
            token: conn.medusaToken,
            withMorning: true,
          });
        } else if (!running) {
          log(`login sync omitido (${decision.reason})`);
          const { runMorningPipeline } = await import("@/lib/morning-run");
          await runMorningPipeline(storeId);
        } else {
          log(`login sync omitido (${decision.reason})`);
        }
        return;
      } catch (e) {
        log(`login pipeline omitido: ${e instanceof Error ? e.message : "error"}`);
      }
      return;
    } catch (e) {
      log(`login sync omitido: ${e instanceof Error ? e.message : "error"}`);
    }
  });
}
