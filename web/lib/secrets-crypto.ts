// Secrets en DB cifrada (issue #20). Módulo PURO: sin Supabase ni red.
// Cifrado app-level AES-256-GCM. La DB solo guarda `v1.<iv>.<tag>.<ct>`
// en base64url. Nunca plaintext en disco ni en logs.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "v1";

function b64uEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64uDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** Parsea SECRETS_ENCRYPTION_KEY: base64(32B) | hex(64) | utf8(32B). */
export function parseEncryptionKey(raw: string): Buffer {
  const v = raw.trim().replace(/^["']|["']$/g, "");
  if (!v) throw new Error("SECRETS_ENCRYPTION_KEY vacía");
  // hex 64 chars -> 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  // base64 / base64url que decodifica a 32 bytes
  try {
    const asB64 = Buffer.from(v, "base64");
    if (asB64.length === 32) return asB64;
  } catch {
    // sigue a utf8
  }
  try {
    const asB64u = Buffer.from(v, "base64url");
    if (asB64u.length === 32) return asB64u;
  } catch {
    // sigue a utf8
  }
  const asUtf8 = Buffer.from(v, "utf8");
  if (asUtf8.length === 32) return asUtf8;
  throw new Error(
    "SECRETS_ENCRYPTION_KEY inválida: usa 32 bytes en base64 (recomendado), hex64 o utf8-32. Genera con: openssl rand -base64 32",
  );
}

/** Key activa desde env. Lanza si no está (el caller decide fallback a JSON). */
export function getEncryptionKey(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY ?? "";
  return parseEncryptionKey(raw);
}

export function isEncryptionConfigured(): boolean {
  try {
    getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** Cifra un secreto. IV aleatorio 12B: dos llamadas nunca dan igual. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("key debe ser 32 bytes (AES-256)");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, b64uEncode(iv), b64uEncode(tag), b64uEncode(ct)].join(".");
}

/** Descifra un payload `v1.*`. Lanza si formato/tag/key inválidos. */
export function decryptSecret(payload: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("key debe ser 32 bytes (AES-256)");
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("payload no es un secreto cifrado v1");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  let iv: Buffer;
  let tag: Buffer;
  let ct: Buffer;
  try {
    iv = b64uDecode(ivB64);
    tag = b64uDecode(tagB64);
    ct = b64uDecode(ctB64);
  } catch {
    throw new Error("payload corrupto (base64)");
  }
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("payload corrupto (iv/tag)");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("descifrado falló (key incorrecta o payload alterado)");
  }
}

export function isEncryptedValue(v: string | null | undefined): boolean {
  if (!v) return false;
  const parts = v.split(".");
  return parts.length === 4 && parts[0] === PREFIX;
}

/** Enmascara para UI/auditoría: nunca la key completa. */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return "••••••••";
  const s = String(secret);
  if (s.length < 8) return "••••••••";
  return `••••••••${s.slice(-4)}`;
}

/** Huella para auditoría (permite ver rotación sin guardar el valor). */
export function fingerprintSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16);
}

/** Mezcla DB sobre JSON: el secreto DB manda; si no hay, cae al JSON (dev). */
export function overlaySecret(
  jsonValue: string | null | undefined,
  dbValue: string | null | undefined,
): string {
  if (dbValue !== null && dbValue !== undefined && dbValue !== "") return dbValue;
  return jsonValue ?? "";
}
