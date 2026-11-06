"use server";

import { revalidatePath } from "next/cache";
import { readConnections, writeConnections } from "@/lib/store";
import type { DefaultChannel, EmailProvider } from "@/lib/store";

export interface SaveState {
  ok: boolean;
  message: string;
  run?: null;
}

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

async function denyWithoutMembership(
  storeId: string | null,
  user: { id: string; email: string | null } | { error: string } | null,
): Promise<string | null> {
  if (!user || "error" in user) return null;
  if (!storeId) return null;
  try {
    const { requireStoreMember } = await import("@/lib/api/guard");
    const denied = await requireStoreMember(storeId, user);
    return denied ? "Sin acceso a esta tienda." : null;
  } catch {
    return "No se pudo verificar acceso a esta tienda. Reintenta.";
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
  const explicitBase = formStoreId
    ? await readConnections(formStoreId).catch(() => null)
    : null;
  const targetBase = explicitBase ?? prev;
  if (!apiKey && provider !== "none" && targetBase.emailApiKey && provider !== targetBase.emailProvider) {
    return { ok: false, message: "Indica la API key del nuevo proveedor (no se reutiliza la anterior)." };
  }
  const denied = await denyWithoutMembership(formStoreId, user);
  if (denied) return { ok: false, message: denied };
  try {
    await writeConnections(
      {
        ...targetBase,
        emailProvider: provider,
        emailFrom: from,
        emailApiKey: apiKey ? apiKey.trim() : targetBase.emailApiKey,
        defaultChannel,
      },
      { storeId: formStoreId },
    );
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
  const denied = await denyWithoutMembership(formStoreId, user);
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
          subject: "MEOW · prueba de conexión",
          text: "Conexión SendGrid OK desde MEOW.",
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

export type RevocableSecret = "email_api_key";

export async function revokeSecretAction(secret: RevocableSecret, storeIdArg?: string | null): Promise<SaveState> {
  const user = await requireSettingsUser();
  if (user && "error" in user) return { ok: false, message: user.error };
  const conn = await readConnections();
  const storeId: string | null = String(storeIdArg ?? "").trim() || null;
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
    }
  }
  const { writeConnectionsJson } = await import("@/lib/store");
  await writeConnectionsJson({ ...conn, emailApiKey: "" });
  revalidatePath("/settings");
  return { ok: true, message: `Secreto ${secret} revocado.` };
}
