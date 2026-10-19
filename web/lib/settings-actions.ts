"use server";

import { revalidatePath } from "next/cache";
import { medusaLogin, testMedusa } from "@/lib/medusa";
import type { MedusaVersion } from "@/lib/medusa";
import { readConnections, writeConnections } from "@/lib/store";
import type { DefaultChannel, EmailProvider, Platform } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/supabase";
import { syncStoreFromMedusa } from "@/lib/sync";

export interface SaveState {
  ok: boolean;
  message: string;
}

export async function saveConnectionsAction(
  _prev: SaveState | null,
  formData: FormData,
): Promise<SaveState> {
  const platform = (String(formData.get("platform") ?? "medusa") || "medusa") as Platform;
  const prev = await readConnections();

  if (platform === "shopify") {
    const shopifyStore = String(formData.get("shopifyStore") ?? "").trim();
    const shopifyToken = String(formData.get("shopifyToken") ?? "").trim();
    await writeConnections({
      ...prev,
      platform,
      shopifyStore: shopifyStore || prev.shopifyStore,
      // Vacío = conservar (los inputs deshabilitados no se envían).
      shopifyToken: shopifyToken || prev.shopifyToken,
    });
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
    await writeConnections({
      ...prev,
      platform,
      medusaUrl,
      medusaVersion: version,
      medusaEmail: email,
      medusaToken: token,
    });
    const result = await testMedusa(medusaUrl, version, token);
    revalidatePath("/settings");
    revalidatePath("/customers");
    if (!result.ok) return { ok: false, message: `Login ok, pero falla lectura: ${result.error}` };
    // Cada auth dispara sync ecommerce → BD (no bloquea el login si falla).
    let syncMsg = "sync omitido (sin Supabase en .env.local)";
    if (isSupabaseConfigured()) {
      try {
        const s = await syncStoreFromMedusa(medusaUrl, version, token);
        syncMsg = `sync: ${s.customers} customers, ${s.orders} orders`;
      } catch (e) {
        syncMsg = `sync falló: ${e instanceof Error ? e.message : "error"}`;
      }
    }
    return { ok: true, message: `Medusa ${version} conectado: ${result.store} · ${syncMsg}` };
  } catch (e) {
    return { ok: false, message: `Medusa falla: ${e instanceof Error ? e.message : "error"}` };
  }
}

export async function saveEmailAction(
  _prev: SaveState | null,
  formData: FormData,
): Promise<SaveState> {
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
  await writeConnections({
    ...prev,
    emailProvider: provider,
    emailFrom: from,
    // Vacío = conservar la guardada (el input viene con placeholder, no con valor).
    emailApiKey: apiKey ? apiKey.trim() : prev.emailApiKey,
    defaultChannel,
  });
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
  const to = String(formData.get("emailTestTo") ?? "").trim();
  if (!to || !to.includes("@")) return { ok: false, message: "Indica un destino válido para la prueba" };
  const conn = await readConnections();
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
