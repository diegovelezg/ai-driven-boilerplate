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
  // Multiuser: se sincroniza la tienda del usuario (su primera membresía),
  // no la conexión global: 5 users del mismo tenant comparten throttle+slot.
  // Nota: solo la primera membresía dispara sync; otras membresías del mismo
  // usuario quedan stale hasta su cron o su propio login con ?store=.
  const { data, error: membersError } = await supabase
    .from("merchant_users")
    .select("store_id")
    .order("created_at", { ascending: true });
  if (membersError) {
    // Fail-closed: sin membresías verificadas no se toca ningún tenant
    // (antes caía al probe global y podía sincronizar la tienda equivocada).
    console.error("[login] merchant_users:", membersError.message);
    redirect(safeNext(next) ?? "/");
  }
  const memberIds = ((data ?? []) as Array<{ store_id: unknown }>)
    .map((r) => String(r.store_id ?? ""))
    .filter(Boolean);
  if (memberIds.length > 1) log(`login multi-membresía (${memberIds.length}): sync solo ${memberIds[0]}`);
  const storeId = memberIds[0] as string | undefined;
  scheduleSyncOnLogin(storeId ?? null);
  const dest = pickSafeNext(next, memberIds) ?? (storeId ? `/?store=${storeId}` : "/");
  redirect(dest);
}

export async function signOutAction(): Promise<void> {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}

/** `next` seguro contra open-redirect: path absoluto same-origin sin
 *  backslash ni slash codificado (`/%2f`, `/\evil`, `//evil`). */
function safeNext(next: string): string | null {
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  if (next.includes("\\")) return null;
  if (/%2f/i.test(next)) return null;
  if (!/^\/[^/\\]/.test(next) && next !== "/") return null;
  return next;
}

/** `next` solo si apunta a una tienda del usuario (o no pide tienda). */
function pickSafeNext(next: string, memberIds: string[]): string | null {
  const safe = safeNext(next);
  if (!safe) return null;
  let store: string | null = null;
  try {
    store = new URL(safe, "http://x").searchParams.get("store");
  } catch {
    return null;
  }
  if (store && !memberIds.includes(store)) return null;
  return safe;
}

/**
 * Login liviano: ejecución directa en `after()`, sin cola.
 * Best-effort: nunca rompe el login; omite si no hay conexión, si Supabase
 * no está configurado o si ya hay un run en curso. Throttle de 12h por
 * tienda (el cron diario es el dueño del full; el login solo cubre
 * staleness) + slot atómico de `runSyncOnce`: N users del mismo tenant
 * comparten throttle+slot, no hacen N fulls.
 * @param targetStoreId tienda del usuario (primera membresía). Null = legacy
 * single-merchant (se resuelve por URL como antes).
 */
function scheduleSyncOnLogin(targetStoreId?: string | null): void {
  after(async () => {
    try {
      const supabaseConfigured = isSupabaseConfigured();
      const { planLoginSync } = await import("@/lib/login-plan");
      const plan = await planLoginSync(targetStoreId ?? null, {
        readConnections: (sid) => readConnections(sid),
        resolveStoreId: (url) => resolveStoreId(url),
        hasRunningRun: async (sid) => hasRunningRun(sid),
        getLastFinishedAt: async (sid, kind) => {
          const { getLastFinishedAt } = await import("@/lib/background");
          return getLastFinishedAt(sid, kind).catch(() => null);
        },
        ensureStore: (url, token) => ensureStore(url, token).catch(() => null),
        supabaseConfigured,
      });
      if (plan.omitReason) {
        log(`login sync omitido store=${targetStoreId} (${plan.omitReason})`);
        return;
      }
      const { conn, probeStoreId, running, decision, storeId } = plan;
      if (!storeId) {
        log(`login sync omitido store=${probeStoreId ?? "?"} (${decision.reason})`);
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
        } else if (!running && conn.medusaUrl && conn.medusaToken) {
          // Solo con backend conectado: sin credenciales el morning LLM
          // quemaría sobre un tenant vacío/stale (el cron lo cubre).
          log(`login sync omitido store=${storeId} (${decision.reason})`);
          const { runMorningPipeline } = await import("@/lib/morning-run");
          await runMorningPipeline(storeId);
        } else {
          log(`login sync omitido store=${storeId} (${decision.reason})`);
        }
        return;
      } catch (e) {
        log(`login pipeline omitido store=${storeId}: ${e instanceof Error ? e.message : "error"}`);
      }
      return;
    } catch (e) {
      log(`login sync omitido store=${targetStoreId ?? "?"}: ${e instanceof Error ? e.message : "error"}`);
    }
  });
}
