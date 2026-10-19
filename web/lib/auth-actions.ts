"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { ensureStore, syncStoreFromMedusa, SYNC_TOTAL } from "@/lib/sync";
import { advanceRun, finishRun, hasRunningRun, startRun } from "@/lib/background";
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
  if (error) return { ok: false, message: "Credenciales inválidas." };
  // Cada inicio de sesión dispara sync ecommerce → BD en background
  // (no bloquea el login si falla; se omite si hay run en curso).
  scheduleSyncOnLogin();
  if (next.startsWith("/") && !next.startsWith("//")) redirect(next);
  const { data } = await supabase.from("merchant_users").select("store_id").limit(1).maybeSingle();
  const storeId = data?.store_id as string | undefined;
  redirect(storeId ? `/?store=${storeId}` : "/");
}

export async function signOutAction(): Promise<void> {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Dispara sync Medusa (futuro: Shopify) en background tras un login exitoso.
 * Best-effort: nunca rompe el login; omite si no hay conexión, si Supabase
 * no está configurado o si ya hay un run en curso.
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
      const decision = shouldSyncOnLogin(conn, {
        supabaseConfigured,
        hasRunningRun: running,
      });
      if (!decision.sync) {
        log(`login sync omitido (${decision.reason})`);
        return;
      }
      const medusaUrl = conn.medusaUrl;
      const token = conn.medusaToken;
      const version = conn.medusaVersion || "v1";
      const storeId =
        (await resolveStoreId(medusaUrl).catch(() => null)) ??
        (await ensureStore(medusaUrl, token));
      if (await hasRunningRun(storeId)) {
        log("login sync omitido (run-en-curso)");
        return;
      }
      const runId = await startRun(storeId, "sync", "Sincronización", SYNC_TOTAL);
      log(`login sync run ${runId} start`);
      try {
        const s = await syncStoreFromMedusa(medusaUrl, version, token, {
          onProgress: (p) =>
            advanceRun(runId, { processed: p.processed, failed: 0, current: p.current }),
        });
        await finishRun(runId, {
          status: "done",
          processed: SYNC_TOTAL,
          failed: 0,
          summary: `${s.customers} customers, ${s.orders} orders (test excl: ${s.excludedTestOrders}, inválidas excl: ${s.excludedInvalidOrders})`,
        });
        log(`login sync run ${runId} done`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "error";
        await finishRun(runId, { status: "error", processed: 0, failed: 0, error: msg });
        log(`login sync run ${runId} error ${msg}`);
        // El sync fallido (ej. Medusa 401 por token vencido) no bloquea la
        // mañana: se trabaja con la BD cacheada (último sync ok).
      }
      // Orquestador de mañana: enrichment → scout (auto-retention) →
      // strategist → copywriter. Corre con o sin sync fresco; el héroe
      // "actuar hoy" llega con borrador ya en Review.
      try {
        const { runMorningPipeline } = await import("@/lib/morning-run");
        await runMorningPipeline(storeId);
      } catch (e) {
        log(`morning omitido: ${e instanceof Error ? e.message : "error"}`);
      }
      return;
    } catch (e) {
      log(`login sync omitido: ${e instanceof Error ? e.message : "error"}`);
    }
  });
}
