// Solo server-side: usa service_role (bypassa RLS). Nunca importar en client components.
// (Sin `import "server-only"`: el worker dedicado `worker.ts` (issue #24) y los
// tests `tsx --test` importan este módulo en node y `server-only` lanza fuera de
// React Server Components. El `resolveActor` dinámico a `supabase-server` sigue
// protegido por try/catch: en node cae a actor por defecto.)
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  getEncryptionKey,
  isEncryptionConfigured,
} from "@/lib/secrets-crypto";

const SECRET_KEYS = ["medusa_token", "shopify_token", "email_api_key"] as const;
export type SecretKeyName = (typeof SECRET_KEYS)[number];

// Campos de conexión no-secretos que TAMBIÉN viven cifrados en DB en prod
// (el JSON local es efímero en contenedores: se pierde en cada redeploy y el
// usuario nextjs no siempre puede escribirlo → EACCES).
const CONN_FIELD_KEYS = ["medusa_url", "medusa_email"] as const;
export type ConnFieldName = (typeof CONN_FIELD_KEYS)[number];

type SecretAction = "upsert" | "revoke";

// Huella para auditoría: reutiliza `fingerprintSecret` (única definición).
const shaShort = fingerprintSecret;

function isSecretsDbReady(): boolean {
  return isSupabaseConfigured() && isEncryptionConfigured();
}

async function resolveActor(explicit?: string | null): Promise<string | null> {
  if (explicit) return explicit;
  try {
    const { createServerSupabase } = await import("@/lib/supabase-server");
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

async function logAudit(
  storeId: string,
  keyName: SecretKeyName | string,
  action: SecretAction,
  plaintextForFingerprint: string | null,
  actor?: string | null,
): Promise<void> {
  try {
    const db = getSupabase();
    await db.from("store_secret_audits").insert({
      store_id: storeId,
      key_name: keyName,
      action,
      key_fingerprint: plaintextForFingerprint ? shaShort(plaintextForFingerprint) : null,
      actor: (await resolveActor(actor)) ?? "settings-ui",
    });
  } catch {
    // Auditoría best-effort: nunca rompe el guardado.
  }
}

/** Lee y descifra los 3 secretos de una tienda. Sin DB/key → nulls (fallback JSON). */
export async function getStoreSecrets(storeId: string): Promise<Record<SecretKeyName, string>> {
  const empty = { medusa_token: "", shopify_token: "", email_api_key: "" };
  if (!isSecretsDbReady()) return { ...empty };
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("store_secrets")
      .select("key_name,encrypted_value")
      .eq("store_id", storeId)
      .in("key_name", [...SECRET_KEYS]);
    if (error) return { ...empty };
    const key = getEncryptionKey();
    const out = { ...empty };
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const name = String(r.key_name ?? "") as SecretKeyName;
      if (!SECRET_KEYS.includes(name)) continue;
      try {
        out[name] = decryptSecret(String(r.encrypted_value ?? ""), key);
      } catch {
        // Fila ilegible (key rotada o corrupta): se trata como no configurada.
        out[name] = "";
      }
    }
    return out;
  } catch {
    return { ...empty };
  }
}

/** Lee y descifra medusa_url / medusa_email de una tienda. Sin DB/key → "" (fallback JSON). */
export async function getStoreConnFields(storeId: string): Promise<Record<ConnFieldName, string>> {
  const empty = { medusa_url: "", medusa_email: "" };
  if (!isSecretsDbReady()) return { ...empty };
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("store_secrets")
      .select("key_name,encrypted_value")
      .eq("store_id", storeId)
      .in("key_name", [...CONN_FIELD_KEYS]);
    if (error) return { ...empty };
    const key = getEncryptionKey();
    const out = { ...empty };
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const name = String(r.key_name ?? "") as ConnFieldName;
      if (!CONN_FIELD_KEYS.includes(name)) continue;
      try {
        out[name] = decryptSecret(String(r.encrypted_value ?? ""), key);
      } catch {
        out[name] = "";
      }
    }
    return out;
  } catch {
    return { ...empty };
  }
}

/**
 * Guarda (o revoca con "" ) un secreto: cifra + upsert + auditoría.
 * Devuelve { migratedToDb: true } si quedó en DB; false si cayó a JSON
 * (sin Supabase/key: el caller escribe el JSON como antes).
 */
export async function setStoreSecret(
  storeId: string,
  keyName: SecretKeyName | ConnFieldName,
  plaintext: string,
  actor?: string | null,
): Promise<{ persistedToDb: boolean }> {
  const value = (plaintext ?? "").trim();
  if (!isSecretsDbReady()) return { persistedToDb: false };
  const db = getSupabase();
  if (!value) {
    const { error } = await db
      .from("store_secrets")
      .delete()
      .eq("store_id", storeId)
      .eq("key_name", keyName);
    if (error) return { persistedToDb: false };
    await logAudit(storeId, keyName, "revoke", null, actor);
    return { persistedToDb: true };
  }
  const key = getEncryptionKey();
  const encrypted = encryptSecret(value, key);
  const { error } = await db.from("store_secrets").upsert(
    {
      store_id: storeId,
      key_name: keyName,
      encrypted_value: encrypted,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id,key_name" },
  );
  if (error) return { persistedToDb: false };
  await logAudit(storeId, keyName, "upsert", value, actor);
  return { persistedToDb: true };
}

