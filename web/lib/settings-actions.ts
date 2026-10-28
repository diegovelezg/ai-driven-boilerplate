"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { getConnector, isConnectorSupported } from "@/lib/connectors";
import type { MedusaVersion } from "@/lib/medusa";
import { readConnections, writeConnections } from "@/lib/store";
import type { DefaultChannel, EmailProvider, Platform } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/supabase";
import { resolveStoreId } from "@/lib/customers-db";
import { ensureStore, normalizeShopUrl } from "@/lib/sync";
import {
  hasConflict,
  type BackgroundRun,
} from "@/lib/background";
import { busyMessage } from "@/lib/operations";

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
 * Membresía por tenant: sin membresía a `storeId` no hay acceso.
 * Sin `storeId` (tienda nueva) permite la creación.
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
    // Fail-closed en mutaciones: si no se pudo verificar la membresía,
    // se deniega en vez de permitir (el dev sin auth ya salió arriba).
    return "No se pudo verificar acceso a esta tienda. Reintenta.";
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
  // Hint de tenant desde el form (?store= activo). Evita que el `prev` global
  // (JSON de otra tienda) autorice o contamine al tenant que se está viendo.
  const formStoreId = String(formData.get("storeId") ?? "").trim() || null;

  // La plataforma está fijada mientras haya credenciales guardadas (el
  // selector viaja deshabilitado + hidden input). Rechazo de defensa ante
  // un POST manipulado: cambiarla con token vivo deja secretos huérfanos.
  if ((prev.medusaToken || prev.shopifyToken || prev.wooConsumerKey || prev.wooConsumerSecret) && platform !== prev.platform) {
    return { ok: false, message: "Revoca el token guardado antes de cambiar de plataforma." };
  }

  if (!isConnectorSupported(platform)) {
    // Preset sin backend (Shopify/Woo hoy): se guarda sin validar contra la
    // plataforma. Agregar backend = registrar el conector en
    // `connectors/index.ts`; este archivo no se toca.
    // Base por tenant: con storeId explícito (?store= activo) se parte de SUS
    // secretos si ya tiene fila en DB; si aún no tiene nada, legacy global
    // (evita borrar el JSON en dev / fallar en tiendas nuevas sin fila).
    const explicitBase = formStoreId
      ? await readConnections(formStoreId).catch(() => null)
      : null;
    const presetBase =
      explicitBase &&
      (explicitBase.medusaUrl ||
        explicitBase.medusaToken ||
        explicitBase.shopifyToken ||
        explicitBase.wooConsumerKey ||
        explicitBase.emailApiKey)
        ? explicitBase
        : prev;
    const denied = await denyWithoutMembership(
      formStoreId ?? (await resolveConnStoreId(prev.medusaUrl)),
      user,
    );
    if (denied) return { ok: false, message: denied };
    if (platform === "woocommerce") {
      const wooStore = String(formData.get("wooStore") ?? "").trim();
      const wooConsumerKey = String(formData.get("wooConsumerKey") ?? "").trim();
      const wooConsumerSecret = String(formData.get("wooConsumerSecret") ?? "").trim();
      try {
        await writeConnections({
          ...presetBase,
          platform,
          wooStore: wooStore || presetBase.wooStore,
          // Vacío = conservar (los inputs deshabilitados no se envían).
          wooConsumerKey: wooConsumerKey || presetBase.wooConsumerKey,
          wooConsumerSecret: wooConsumerSecret || presetBase.wooConsumerSecret,
        });
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "No se pudo guardar." };
      }
      revalidatePath("/settings");
      return { ok: true, message: "Preset WooCommerce guardado (aún sin backend)." };
    }
    const shopifyStore = String(formData.get("shopifyStore") ?? "").trim();
    const shopifyToken = String(formData.get("shopifyToken") ?? "").trim();
    try {
      await writeConnections({
        ...presetBase,
        platform,
        shopifyStore: shopifyStore || presetBase.shopifyStore,
        // Vacío = conservar (los inputs deshabilitados no se envían).
        shopifyToken: shopifyToken || presetBase.shopifyToken,
      });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "No se pudo guardar." };
    }
    revalidatePath("/settings");
    return { ok: true, message: "Preset Shopify guardado (aún sin backend)." };
  }

  const rawUrl = String(formData.get("medusaUrl") ?? "").trim();
  // Normaliza esquema ("api.tienda.com" → https://...) antes de todo: login,
  // match de tienda y guardado usan la misma forma canónica.
  const medusaUrl = normalizeShopUrl(rawUrl);
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
    const connector = getConnector(platform);
    const jwt = await connector.authenticate(medusaUrl, { email, password, version });
    // v1 by-the-book server-to-server: el JWT expira (~15min); el api_token
    // personal no caduca. Se auto-provisiona con el JWT recién logueado (sin
    // VPS ni GUI) y se guarda ESO en vez del JWT. Configura-una-vez: si el
    // provisioning falla NO se guarda el JWT temporal (sería el 401
    // recurrente "cada tanto"); se devuelve error para reintentar el guardado.
    let token = jwt;
    if (version === "v1") {
      try {
        const { medusaEnsureV1ApiToken, isJwtToken } = await import("@/lib/medusa");
        token = await medusaEnsureV1ApiToken(medusaUrl, jwt);
        if (isJwtToken(token)) {
          return { ok: false, message: "Login ok pero el token generado no es api_token permanente. Nada se guardó; reintenta." };
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return { ok: false, message: `Login ok pero no se pudo generar api_token permanente: ${detail}. Nada se guardó (guardar el JWT temporal causaría 401 cada ~15min). Revisa que el usuario Medusa sea admin y reintenta.` };
      }
    }
    // Cross-tenant: si la tienda ya existe, exige membresía antes de rotar
    // su token. El destino es la tienda de la URL (canónico); el hint del
    // form solo vale para tiendas aún no creadas (sin fila que resolver).
    const destStoreId = (await resolveConnStoreId(medusaUrl)) ?? formStoreId;
    const denied = await denyWithoutMembership(destStoreId, user);
    if (denied) return { ok: false, message: denied };
    // Base por tenant: si la tienda ya tiene fila en DB, se parte de SUS
    // secretos (no de los del JSON global de otra tienda). Sin fila, legacy.
    const destBase = destStoreId
      ? await readConnections(destStoreId).catch(() => null)
      : null;
    const base =
      destBase &&
      (destBase.medusaUrl ||
        destBase.medusaToken ||
        destBase.shopifyToken ||
        destBase.wooConsumerKey ||
        destBase.emailApiKey)
        ? destBase
        : prev;
    try {
      await writeConnections({
        ...base,
        platform,
        medusaUrl,
        medusaVersion: version,
        medusaEmail: email,
        medusaToken: token,
      });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Token obtenido pero no se pudo guardar." };
    }
    const result = await connector.testConnection(medusaUrl, token, version);
    revalidatePath("/settings");
    revalidatePath("/customers");
    if (!result.ok) return { ok: false, message: `Token guardado, pero falla lectura: ${result.error} · Revisa permisos del usuario Medusa.` };
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
    // Sin cola: ejecución directa en `after()` (la respuesta no espera).
    // `runSyncOnce` reclama slot atómico y escribe la cinta visible.
    // Se devuelve run:null a propósito: `getLatestRun` aquí leería la corrida
    // ANTERIOR (el `after()` aún no reclamó slot) y el cliente seguiría un run
    // rancio. La corrida real aparece vía el poll de la cinta (≤6s).
    const { runSyncOnce } = await import("@/lib/sync-runner");
    after(() => {
      runSyncOnce(storeId, medusaUrl, {
        version,
        token,
        withMorning: false,
      }).catch((e) => console.error("[settings] sync error:", e instanceof Error ? e.message : e));
    });
    return {
      ok: true,
      message: `Medusa ${version} conectado: ${result.store} · sync en curso (progreso abajo a la derecha).`,
      run: null,
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
  const formStoreId = String(formData.get("storeId") ?? "").trim() || null;
  const prev = await readConnections();
  // Con storeId explícito (?store= activo) la key a conservar y la membresía
  // se resuelven contra ESE tenant; sin él, legacy global. Si el tenant aún
  // no tiene fila en DB (explicit vacío), se conserva el legacy.
  const explicitBase = formStoreId
    ? await readConnections(formStoreId).catch(() => null)
    : null;
  const targetBase =
    explicitBase &&
    (explicitBase.medusaUrl ||
      explicitBase.medusaToken ||
      explicitBase.emailApiKey ||
      explicitBase.emailFrom)
      ? explicitBase
      : prev;
  // Sin key nueva no se reutiliza la de otro proveedor: cambiar de
  // proveedor exige su propia key (el selector viaja bloqueado con key
  // guardada; esto cubre el POST manipulado).
  if (!apiKey && provider !== "none" && targetBase.emailApiKey && provider !== targetBase.emailProvider) {
    return { ok: false, message: "Indica la API key del nuevo proveedor (no se reutiliza la anterior)." };
  }
  const denied = await denyWithoutMembership(
    formStoreId ?? (await resolveConnStoreId(prev.medusaUrl)),
    user,
  );
  if (denied) return { ok: false, message: denied };
  try {
    await writeConnections({
      ...targetBase,
      emailProvider: provider,
      emailFrom: from,
      // Vacío = conservar la guardada (el input viene con placeholder, no con valor).
      emailApiKey: apiKey ? apiKey.trim() : targetBase.emailApiKey,
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
  const formStoreId = String(formData.get("storeId") ?? "").trim() || null;
  const conn = formStoreId
    ? await readConnections(formStoreId).catch(() => readConnections())
    : await readConnections();
  const denied = await denyWithoutMembership(
    formStoreId ?? (await resolveConnStoreId(conn.medusaUrl)),
    user,
  );
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

export type RevocableSecret = "medusa_token" | "shopify_token" | "woo_consumer_key" | "woo_consumer_secret" | "email_api_key";

/**
 * Revoca un secreto (issue #20): borra la fila en `store_secrets` (+ auditoría)
 * y limpia el fallback JSON. Sin DB/key, limpia solo el JSON (dev).
 * El password de Medusa nunca se guarda (solo token post-login).
 */
export async function revokeSecretAction(secret: RevocableSecret, storeIdArg?: string | null): Promise<SaveState> {
  const user = await requireSettingsUser();
  if (user && "error" in user) return { ok: false, message: user.error };
  const conn = await readConnectionsJsonSafe();
  // storeId explícito (?store= activo) manda: revoca ESE tenant, no el del
  // JSON global. Sin él, legacy: JSON → tienda única en DB.
  const explicitStoreId = String(storeIdArg ?? "").trim() || null;
  let storeId: string | null = explicitStoreId;
  if (!storeId && isSupabaseConfigured() && conn.medusaUrl) {
    try {
      const { resolveStoreId } = await import("@/lib/customers-db");
      storeId = await resolveStoreId(conn.medusaUrl).catch(() => null);
    } catch {
      storeId = null;
    }
  }
  // JSON vacío en prod (efímero entre redeploys): si hay UNA sola tienda
  // medusa en DB, revoca ahí en vez de reportar éxito falso solo en JSON.
  if (!storeId && isSupabaseConfigured()) {
    try {
      const { getSupabase } = await import("@/lib/supabase");
      const { data } = await getSupabase()
        .from("stores")
        .select("id")
        .eq("platform", "medusa")
        .limit(2);
      const rows = (data ?? []) as Array<{ id: string }>;
      if (rows.length === 1) storeId = rows[0].id;
    } catch {
      // Sigue al JSON como fallback.
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
    secret === "medusa_token"
      ? "medusaToken"
      : secret === "shopify_token"
        ? "shopifyToken"
        : secret === "woo_consumer_key"
          ? "wooConsumerKey"
          : secret === "woo_consumer_secret"
            ? "wooConsumerSecret"
            : "emailApiKey";
  await writeConnectionsJson({ ...conn, [jsonKey]: "" });
  revalidatePath("/settings");
  return { ok: true, message: `Secreto ${secret} revocado.` };
}

async function readConnectionsJsonSafe() {
  const { readConnections } = await import("@/lib/store");
  return readConnections();
}
