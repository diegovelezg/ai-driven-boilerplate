// Capa DB de secrets (issue #20). Solo server-side: usa service_role
// (bypassa RLS). Nunca importar en client components.
import "server-only";
import { createHash } from "node:crypto";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  getEncryptionKey,
  isEncryptionConfigured,
  maskSecret,
} from "@/lib/secrets-crypto";

export const SECRET_KEYS = ["medusa_token", "shopify_token", "email_api_key"] as const;
export type SecretKeyName = (typeof SECRET_KEYS)[number];

export type SecretAction = "upsert" | "revoke" | "migrate";

export interface SecretStatus {
  keyName: SecretKeyName;
  configured: boolean;
  masked: string;
  updatedAt: string | null;
}

export interface SecretAuditRow {
  id: string;
  storeId: string;
  keyName: string;
  action: SecretAction;
  keyFingerprint: string | null;
  actor: string | null;
  createdAt: string;
}

function shaShort(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

export function isSecretsDbReady(): boolean {
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

/** Estado sin valores (para Settings): configurado + máscara + updated_at. */
export async function getStoreSecretStatus(storeId: string): Promise<SecretStatus[]> {
  const secrets = await getStoreSecrets(storeId);
  const updatedByKey = new Map<string, string>();
  if (isSupabaseConfigured()) {
    try {
      const { data } = await getSupabase()
        .from("store_secrets")
        .select("key_name,updated_at")
        .eq("store_id", storeId)
        .in("key_name", [...SECRET_KEYS]);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        updatedByKey.set(String(r.key_name ?? ""), String(r.updated_at ?? ""));
      }
    } catch {
      // sin updated_at: se muestra sin fecha
    }
  }
  return SECRET_KEYS.map((k) => ({
    keyName: k,
    configured: !!secrets[k],
    masked: maskSecret(secrets[k] || null),
    updatedAt: updatedByKey.get(k) ?? null,
  }));
}

/**
 * Guarda (o revoca con "" ) un secreto: cifra + upsert + auditoría.
 * Devuelve { migratedToDb: true } si quedó en DB; false si cayó a JSON
 * (sin Supabase/key: el caller escribe el JSON como antes).
 */
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

/** Últimas auditorías (sin valores, solo quién/cuándo/qué). */
export async function getSecretAudits(
  storeId: string,
  limit = 20,
): Promise<SecretAuditRow[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const { data, error } = await getSupabase()
      .from("store_secret_audits")
      .select("id,store_id,key_name,action,key_fingerprint,actor,created_at")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 100));
    if (error) return [];
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id ?? ""),
      storeId: String(r.store_id ?? ""),
      keyName: String(r.key_name ?? ""),
      action: String(r.action ?? "upsert") as SecretAction,
      keyFingerprint: (r.key_fingerprint as string | null) ?? null,
      actor: (r.actor as string | null) ?? null,
      createdAt: String(r.created_at ?? ""),
    }));
  } catch {
    return [];
  }
}

export { fingerprintSecret };
