// Solo server-side: lee/escribe secretos (service_role + AES-GCM) y el
// fallback JSON local. Nunca importar valores en client components: los
// tipos (`import type`) se borran en build y son seguros, pero cualquier
// valor serializado a props de cliente expone los secretos en el Flight
// payload. Para la UI usa `toSafeConnections()` (solo booleanos has*).
// (Sin `import "server-only"`: los tests `tsx --test` importan este módulo en
// node y `server-only` lanza fuera de React Server Components.)
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MedusaVersion } from "@/lib/medusa";

export type Platform = "medusa" | "shopify";

export type EmailProvider = "sendgrid" | "resend" | "none";

export type DefaultChannel = "email" | "whatsapp";

export interface StoreConnections {
  platform: Platform;
  medusaUrl: string;
  medusaVersion: MedusaVersion | "";
  medusaEmail: string;
  medusaToken: string;
  shopifyStore: string;
  shopifyToken: string;
  emailProvider: EmailProvider;
  emailFrom: string;
  emailApiKey: string;
  defaultChannel: DefaultChannel;
}

const DATA_DIR = join(process.cwd(), ".data");
const CONFIG_FILE = join(DATA_DIR, "connections.json");

const SECRET_JSON_KEYS = ["medusaToken", "shopifyToken", "emailApiKey"] as const;

const EMPTY: StoreConnections = {
  platform: "medusa",
  medusaUrl: "",
  medusaVersion: "",
  medusaEmail: "",
  medusaToken: "",
  shopifyStore: "",
  shopifyToken: "",
  emailProvider: "sendgrid",
  emailFrom: "",
  emailApiKey: "",
  defaultChannel: "email",
};

/**
 * DTO seguro para client components (settings UI). Contiene los mismos
 * campos no-secretos más booleanos `has*`; NUNCA el valor de los secretos.
 * Serializar `StoreConnections` completo a un `"use client"` expone las
 * keys en el Flight payload / HTML (aunque la UI pinte ••••).
 */
export interface SafeStoreConnections {
  platform: Platform;
  medusaUrl: string;
  medusaVersion: MedusaVersion | "";
  medusaEmail: string;
  hasMedusaToken: boolean;
  shopifyStore: string;
  hasShopifyToken: boolean;
  emailProvider: EmailProvider;
  emailFrom: string;
  hasEmailApiKey: boolean;
  defaultChannel: DefaultChannel;
}

export function toSafeConnections(c: StoreConnections): SafeStoreConnections {
  return {
    platform: c.platform,
    medusaUrl: c.medusaUrl,
    medusaVersion: c.medusaVersion,
    medusaEmail: c.medusaEmail,
    hasMedusaToken: Boolean(c.medusaToken),
    shopifyStore: c.shopifyStore,
    hasShopifyToken: Boolean(c.shopifyToken),
    emailProvider: c.emailProvider,
    emailFrom: c.emailFrom,
    hasEmailApiKey: Boolean(c.emailApiKey),
    defaultChannel: c.defaultChannel,
  };
}

async function readConnectionsJson(): Promise<StoreConnections> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY };
  }
}

export async function writeConnectionsJson(next: StoreConnections): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
  // mkdir/writeFile no garantizan el modo si el archivo ya existía (umask):
  // fuerza 600 (solo owner) para que el fallback JSON nunca quede 644.
  await chmod(CONFIG_FILE, 0o600).catch(() => {});
}

/**
 * Lee conexiones con overlay DB (issue #20): lo no-secreto sale del JSON
 * local; los 3 secretos se resuelven por tienda desde `store_secrets`
 * (cifrado AES-256-GCM) cuando hay Supabase + SECRETS_ENCRYPTION_KEY.
 * Sin DB/key o sin tienda resuelta, cae al JSON (dev/single-merchant).
 * Nunca lanza: ante cualquier fallo devuelve el JSON.
 */
export async function readConnections(storeId?: string | null): Promise<StoreConnections> {
  const json = await readConnectionsJson();
  try {
    const { isSupabaseConfigured } = await import("@/lib/supabase");
    const { isEncryptionConfigured, overlaySecret } = await import("@/lib/secrets-crypto");
    if (!isSupabaseConfigured() || !isEncryptionConfigured()) return json;
    let sid = storeId ?? null;
    if (!sid && json.medusaUrl) {
      try {
        const { resolveStoreId } = await import("@/lib/customers-db");
        sid = await resolveStoreId(json.medusaUrl).catch(() => null);
      } catch {
        sid = null;
      }
    }
    if (!sid) return json;
    const { getStoreSecrets } = await import("@/lib/store-secrets");
    const db = await getStoreSecrets(sid).catch(() => null);
    if (!db) return json;
    // Overlay: el secreto DB manda SOLO si no es vacío; si la tienda existe
    // en DB pero aún sin fila (migración pendiente), se conserva el JSON.
    return {
      ...json,
      medusaToken: overlaySecret(json.medusaToken, db.medusa_token),
      shopifyToken: overlaySecret(json.shopifyToken, db.shopify_token),
      emailApiKey: overlaySecret(json.emailApiKey, db.email_api_key),
    };
  } catch {
    return json;
  }
}

export interface WriteConnectionsOpts {
  /** Tienda destino de los secretos. Si se omite, se deriva de medusaUrl. */
  storeId?: string | null;
}

/**
 * Escribe conexiones: lo no-secreto siempre al JSON; los secretos van a DB
 * cifrada cuando hay tienda + Supabase + key, y se BORRAN del JSON
 * (no queda plaintext en disco). Sin DB/key, JSON como antes (dev).
 *
 * Si la DB era el destino esperado pero el upsert falla (caída transitoria),
 * NO se escribe el secreto nuevo en plaintext al JSON: se conserva el valor
 * previo del JSON y se lanza, para que el caller devuelva error en vez de
 * un "guardado" que dejó la key en disco.
 */
export async function writeConnections(
  next: StoreConnections,
  opts: WriteConnectionsOpts = {},
): Promise<void> {
  const scrub = new Set<string>();
  const prevJson = await readConnectionsJson().catch(() => null);
  const dbFailed: string[] = [];
  try {
    const { isSupabaseConfigured } = await import("@/lib/supabase");
    const { isEncryptionConfigured } = await import("@/lib/secrets-crypto");
    if (isSupabaseConfigured() && isEncryptionConfigured()) {
      let sid = opts.storeId ?? null;
      if (!sid && next.medusaUrl) {
        try {
          const { resolveStoreId } = await import("@/lib/customers-db");
          sid = await resolveStoreId(next.medusaUrl).catch(() => null);
        } catch {
          sid = null;
        }
      }
      if (sid) {
        const { setStoreSecret } = await import("@/lib/store-secrets");
        const pairs: Array<[string, "medusa_token" | "shopify_token" | "email_api_key", string]> = [
          ["medusaToken", "medusa_token", next.medusaToken],
          ["shopifyToken", "shopify_token", next.shopifyToken],
          ["emailApiKey", "email_api_key", next.emailApiKey],
        ];
        for (const [jsonKey, dbKey, val] of pairs) {
          // Solo toca la key que el caller trae non-empty o que ya existe en
          // DB: un write parcial (ej. solo email) no debe revocar las demás.
          // Si el valor es "" y no hay fila previa, no hay nada que hacer.
          if (!val) continue;
          const r = await setStoreSecret(sid, dbKey, val).catch(() => null);
          if (r?.persistedToDb) scrub.add(jsonKey);
          else dbFailed.push(jsonKey);
        }
        // Si el caller pidió revocar explícitamente ("" con intención), lo
        // hace via revokeStoreSecretAction, no aquí.
      }
    }
  } catch {
    // Fallback a JSON plano (dev).
  }
  if (dbFailed.length > 0) {
    // La DB debía guardar estos secretos y falló: no persistir el plaintext
    // nuevo en disco. Revierte esas keys al valor previo del JSON y lanza.
    const reverted = { ...next };
    for (const k of dbFailed) {
      (reverted as Record<string, string>)[k] =
        (prevJson as Record<string, string> | null)?.[k] ?? "";
    }
    // Persiste lo no-secreto + los scrubbed igualmente (sin los fallidos).
    const scrubbed = { ...reverted };
    for (const k of scrub) {
      if ((SECRET_JSON_KEYS as readonly string[]).includes(k)) {
        (scrubbed as Record<string, string>)[k] = "";
      }
    }
    await writeConnectionsJson(scrubbed);
    throw new Error(
      `No se pudo cifrar en DB (${dbFailed.join(", ")}); no se guardó en disco. Reintenta.`,
    );
  }
  if (scrub.size > 0) {
    const scrubbed = { ...next };
    for (const k of scrub) {
      if ((SECRET_JSON_KEYS as readonly string[]).includes(k)) {
        (scrubbed as Record<string, string>)[k] = "";
      }
    }
    await writeConnectionsJson(scrubbed);
    return;
  }
  // Sin DB esperada (dev) o sin secretos nuevos: JSON como antes.
  // Si la DB era esperada pero no hubo sid (tienda aún no resuelta), el
  // secreto queda en JSON temporalmente hasta el primer sync con DB.
  await writeConnectionsJson(next);
}
