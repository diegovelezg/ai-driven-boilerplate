// Solo server-side: usa service_role (bypassa RLS). Sin ecommerce.
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  getEncryptionKey,
  isEncryptionConfigured,
} from "@/lib/secrets-crypto";

const SECRET_KEYS = ["email_api_key"] as const;
export type SecretKeyName = (typeof SECRET_KEYS)[number];

const CONN_FIELD_KEYS = [] as const;
export type ConnFieldName = (typeof CONN_FIELD_KEYS)[number];

type SecretAction = "upsert" | "revoke";
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
  }
}

export async function getStoreSecrets(storeId: string): Promise<Record<SecretKeyName, string>> {
  const empty = { email_api_key: "" };
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
        out[name] = "";
      }
    }
    return out;
  } catch {
    return { ...empty };
  }
}

export async function getStoreConnFields(_storeId: string): Promise<Record<string, string>> {
  return {};
}

export async function setStoreSecret(
  storeId: string,
  keyName: SecretKeyName,
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
