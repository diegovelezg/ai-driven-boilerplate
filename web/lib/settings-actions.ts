"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { medusaLogin, testMedusa } from "@/lib/medusa";
import type { MedusaVersion } from "@/lib/medusa";
import { readConnections, writeConnections } from "@/lib/store";
import type { DefaultChannel, EmailProvider, Platform } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/supabase";
import { resolveStoreId } from "@/lib/customers-db";
import { ensureStore, syncStoreFromMedusa, SYNC_TOTAL } from "@/lib/sync";
import {
  advanceRun,
  finishRun,
  getLatestRun,
  hasConflict,
  startRun,
  type BackgroundRun,
} from "@/lib/background";
import { busyMessage } from "@/lib/operations";
import { formatNumber } from "@/lib/format";

export interface SaveState {
  ok: boolean;
  message: string;
  /** Corrida visible en la cinta (solo el connect con sync la devuelve). */
  run?: BackgroundRun | null;
}

/**
 * Sesión exigida para mutar secretos (P1). Sin auth configurada (dev sin
 * Supabase Auth), permite (legacy). Con auth, sin usuario → error.
 */
async function requireSettingsUser(): Promise<{ id: string; email: string | null } | { error: string } | null> {
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
    if (!data.user) return { error: "No autenticado. Inicia sesión." };
    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return { error: "No autenticado. Inicia sesión." };
  }
}

/**
 * Membresía por tenant, legacy-tolerante: si el usuario no tiene ninguna
 * membresía (single-tenant pre-migración), permite. Si tiene y no incluye
 * `storeId`, deniega. Sin `storeId` (tienda nueva) permite la creación.
 */
async function denyWithoutMembership(
  storeId: string | null,
  user: { id: string; email: string | null } | { error: string } | null,
): Promise<string | null> {
  if (!user || "error" in user) return null; // dev o ya denegado arriba
  if (!storeId) return null; // creación de tienda nueva
  try {
    const { requireStoreMember } = await import("@/lib/api/guard");
    const denied = await requireStoreMember(storeId, user);
    return denied ? "Sin acceso a esta tienda." : null;
  } catch {
    return null;
  }
}

async function resolveConnStoreId(medusaUrl: string): Promise<string | null> {
  if (!isSupabaseConfigured() || !medusaUrl) return null;
  try {
    return await resolveStoreId(medusaUrl).catch(() => null);
  } catch {
    return null;
  }
}

export async function saveConnectionsAction(
  _prev: SaveState | null,
  formData: FormData,
): Promise<SaveState> {
  const user = await requireSettingsUser();
  if (user && "error" in user) return { ok: false, message: user.error };
  const platform = (String(formData.get("platform") ?? "medusa") || "medusa") as Platform;
  const prev = await readConnections();

  // La plataforma está fijada mientras haya credenciales guardadas (el
  // selector viaja deshabilitado + hidden input). Rechazo de defensa ante
  // un POST manipulado: cambiarla con token vivo deja secretos huérfanos.
  if ((prev.medusaToken || prev.shopifyToken) && platform !== prev.platform) {
    return { ok: false, message: "Revoca el token guardado antes de cambiar de plataforma." };
  }

  if (platform === "shopify") {
    const shopifyStore = String(formData.get("shopifyStore") ?? "").trim();
    const shopifyToken = String(formData.get("shopifyToken") ?? "").trim();
    const denied = await denyWithoutMembership(await resolveConnStoreId(prev.medusaUrl), user);
    if (denied) return { ok: false, message: denied };
    try {
      await writeConnections({
        ...prev,
        platform,
        shopifyStore: shopifyStore || prev.shopifyStore,
        // Vacío = conservar (los inputs deshabilitados no se envían).
        shopifyToken: shopifyToken || prev.shopifyToken,
      });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "No se pudo guardar." };
    }
    revalidatePath("/settings");
    return { ok: true, message: "Preset Shopify guardado (aún sin backend)." };
  }

  const medusaUrl = String(formData.get("medusaUrl") ?? "").trim();
  const email = String(formData.get("medusaEmail") ?? "").trim();
  const password = String(formData.get("medusaPassword") ?? "");
  const version = String(formData.get("medusaVersion") ?? "") as MedusaVersion;

  if (!medusaUrl || !email || !password) {
    return { ok: false, message: "Falta URL, email o password" };
  }

  if (version !== "v1" && version !== "v2") {
    return { ok: false, message: "Elige la versión de Medusa (v1 o v2)" };
  }

  try {
    const token = await medusaLogin(medusaUrl, version, email, password);
    // Cross-tenant: si la tienda ya existe, exige membresía antes de rotar su token.
    const denied = await denyWithoutMembership(await resolveConnStoreId(medusaUrl), user);
    if (denied) return { ok: false, message: denied };
    try {
      await writeConnections({
        ...prev,
        platform,
        medusaUrl,
        medusaVersion: version,
        medusaEmail: email,
        medusaToken: token,
      });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Token obtenido pero no se pudo guardar." };
    }
    const result = await testMedusa(medusaUrl, version, token);
    revalidatePath("/settings");
    revalidatePath("/customers");
    if (!result.ok) return { ok: false, message: `Login ok, pero falla lectura: ${result.error}` };
    // Sync en background con corrida visible (MO único: toda mutación larga
    // va a la cinta de toasts). Antes bloqueaba el submit segundos sin
    // progreso; el cliente envuelve en `bg.start` y el toast lo sigue.
    if (!isSupabaseConfigured()) {
      return { ok: true, message: `Medusa ${version} conectado: ${result.store} · sync omitido (sin Supabase en .env.local)` };
    }
    let storeId: string;
    try {
      storeId = (await resolveStoreId(medusaUrl)) ?? (await ensureStore(medusaUrl, token));
    } catch (e) {
      return { ok: true, message: `Medusa ${version} conectado: ${result.store} · sync no iniciado: ${e instanceof Error ? e.message : "error"}` };
    }
    const syncConflict = await hasConflict(storeId, { kind: "sync" }).catch(() => null);
    if (syncConflict) {
      return {
        ok: true,
        message: `Medusa ${version} conectado: ${result.store} · ${busyMessage(syncConflict)}`,
        run: syncConflict,
      };
    }
    let syncRunId: string | null = null;
    try {
      syncRunId = await startRun(storeId, "sync", "Sincronización", SYNC_TOTAL);
    } catch (e) {
      return { ok: true, message: `Medusa ${version} conectado: ${result.store} · sync no registrado: ${e instanceof Error ? e.message : "error"}` };
    }
    const runId = syncRunId;
    const syncUrl = medusaUrl;
    const syncToken = token;
    const syncVersion = version;
    after(async () => {
      try {
        const s = await syncStoreFromMedusa(syncUrl, syncVersion, syncToken, {
          onProgress: (p) => {
            advanceRun(runId, { processed: p.processed, failed: 0, current: p.current }).catch(() => {});
          },
        });
        await finishRun(runId, {
          status: "done",
          processed: SYNC_TOTAL,
          failed: 0,
          summary: `${formatNumber(s.customers)} customers, ${formatNumber(s.orders)} orders`,
        });
      } catch (e) {
        await finishRun(runId, {
          status: "error",
          processed: 0,
          failed: 0,
          error: e instanceof Error ? e.message : "error",
        }).catch(() => undefined);
      }
      revalidatePath("/settings");
      revalidatePath("/customers");
    });
    return {
      ok: true,
      message: `Medusa ${version} conectado: ${result.store} · sync en curso (progreso abajo a la derecha).`,
      run: await getLatestRun(storeId).catch(() => null),
    };
  } catch (e) {
    return { ok: false, message: `Medusa falla: ${e instanceof Error ? e.message : "error"}` };
  }
}

export async function saveEmailAction(
  _prev: SaveState | null,
  formData: FormData,
): Promise<SaveState> {
  const user = await requireSettingsUser();
  if (user && "error" in user) return { ok: false, message: user.error };
  const provider = String(formData.get("emailProvider") ?? "sendgrid") as EmailProvider;
  const from = String(formData.get("emailFrom") ?? "").trim();
  const apiKey = String(formData.get("emailApiKey") ?? "");
  const rawChannel = String(formData.get("defaultChannel") ?? "email");
  const defaultChannel: DefaultChannel = rawChannel === "whatsapp" ? "whatsapp" : "email";
  if (provider !== "sendgrid" && provider !== "resend" && provider !== "none") {
    return { ok: false, message: "Proveedor email inválido" };
  }
  if (provider !== "none" && !from) {
    return { ok: false, message: "Falta remitente (from)" };
  }
  const prev = await readConnections();
  // Sin key nueva no se reutiliza la de otro proveedor: cambiar de
  // proveedor exige su propia key (el selector viaja bloqueado con key
  // guardada; esto cubre el POST manipulado).
  if (!apiKey && provider !== "none" && prev.emailApiKey && provider !== prev.emailProvider) {
    return { ok: false, message: "Indica la API key del nuevo proveedor (no se reutiliza la anterior)." };
  }
  const denied = await denyWithoutMembership(await resolveConnStoreId(prev.medusaUrl), user);
  if (denied) return { ok: false, message: denied };
  try {
    await writeConnections({
      ...prev,
      emailProvider: provider,
      emailFrom: from,
      // Vacío = conservar la guardada (el input viene con placeholder, no con valor).
      emailApiKey: apiKey ? apiKey.trim() : prev.emailApiKey,
      defaultChannel,
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "No se pudo guardar." };
  }
  revalidatePath("/settings");
  return {
    ok: true,
    message:
      provider === "none"
        ? "Email desactivado."
        : apiKey
          ? `Email ${provider} guardado.`
          : `Email ${provider} guardado (key anterior conservada).`,
  };
}

export async function testEmailAction(
  _prev: SaveState | null,
  formData: FormData,
): Promise<SaveState> {
  const user = await requireSettingsUser();
  if (user && "error" in user) return { ok: false, message: user.error };
  const to = String(formData.get("emailTestTo") ?? "").trim();
  if (!to || !to.includes("@")) return { ok: false, message: "Indica un destino válido para la prueba" };
  const conn = await readConnections();
  const denied = await denyWithoutMembership(await resolveConnStoreId(conn.medusaUrl), user);
  if (denied) return { ok: false, message: denied };
  if (conn.emailProvider === "none" || !conn.emailApiKey || !conn.emailFrom) {
    return { ok: false, message: "Guarda primero proveedor, from y API key" };
  }
  try {
    if (conn.emailProvider === "sendgrid") {
      const { sendViaSendGrid } = await import("@/lib/comms/email/sendgrid");
      const r = await sendViaSendGrid({
        apiKey: conn.emailApiKey,
        from: conn.emailFrom,
        msg: {
          to,
          subject: "AI Retention Engine · prueba de conexión",
          text: "Conexión SendGrid OK desde AI Retention Engine.",
        },
      });
      revalidatePath("/settings");
      return r.ok
        ? { ok: true, message: `Prueba enviada a ${to} vía SendGrid.` }
        : { ok: false, message: r.error ?? "SendGrid falló" };
    }
    return { ok: false, message: `Proveedor ${conn.emailProvider} aún sin backend (solo SendGrid).` };
  } catch (e) {
    return { ok: false, message: `Prueba falla: ${e instanceof Error ? e.message : "error"}` };
  }
}

export type RevocableSecret = "medusa_token" | "shopify_token" | "email_api_key";

/**
 * Revoca un secreto (issue #20): borra la fila en `store_secrets` (+ auditoría)
 * y limpia el fallback JSON. Sin DB/key, limpia solo el JSON (dev).
 * El password de Medusa nunca se guarda (solo token post-login).
 */
export async function revokeSecretAction(secret: RevocableSecret): Promise<SaveState> {
  const user = await requireSettingsUser();
  if (user && "error" in user) return { ok: false, message: user.error };
  const conn = await readConnectionsJsonSafe();
  let storeId: string | null = null;
  if (isSupabaseConfigured() && conn.medusaUrl) {
    try {
      const { resolveStoreId } = await import("@/lib/customers-db");
      storeId = await resolveStoreId(conn.medusaUrl).catch(() => null);
    } catch {
      storeId = null;
    }
  }
  const denied = await denyWithoutMembership(storeId, user);
  if (denied) return { ok: false, message: denied };
  if (storeId) {
    try {
      const { isEncryptionConfigured } = await import("@/lib/secrets-crypto");
      if (isEncryptionConfigured()) {
        const { setStoreSecret } = await import("@/lib/store-secrets");
        await setStoreSecret(storeId, secret, "");
      }
    } catch {
      // Sigue al JSON como fallback.
    }
  }
  const { writeConnectionsJson } = await import("@/lib/store");
  const jsonKey =
    secret === "medusa_token" ? "medusaToken" : secret === "shopify_token" ? "shopifyToken" : "emailApiKey";
  await writeConnectionsJson({ ...conn, [jsonKey]: "" });
  revalidatePath("/settings");
  return { ok: true, message: `Secreto ${secret} revocado.` };
}

async function readConnectionsJsonSafe() {
  const { readConnections } = await import("@/lib/store");
  return readConnections();
}
