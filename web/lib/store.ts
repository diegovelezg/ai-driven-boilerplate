// Solo server-side: lee/escribe secretos email + fallback JSON local.
// Sin ecommerce: la ingesta es Sheet/CSV (DOOH). Sin plataformas externas.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type EmailProvider = "sendgrid" | "resend" | "none";

export type DefaultChannel = "email" | "whatsapp";

export interface StoreConnections {
  emailProvider: EmailProvider;
  emailFrom: string;
  emailApiKey: string;
  defaultChannel: DefaultChannel;
}

const DATA_DIR = join(process.cwd(), ".data");
const CONFIG_FILE = join(DATA_DIR, "connections.json");

const SECRET_JSON_KEYS = ["emailApiKey"] as const;
const DB_BACKED_JSON_KEYS = [...SECRET_JSON_KEYS] as const;

const EMPTY: StoreConnections = {
  emailProvider: "sendgrid",
  emailFrom: "",
  emailApiKey: "",
  defaultChannel: "email",
};

export interface SafeStoreConnections {
  emailProvider: EmailProvider;
  emailFrom: string;
  hasEmailApiKey: boolean;
  defaultChannel: DefaultChannel;
}

export function toSafeConnections(c: StoreConnections): SafeStoreConnections {
  return {
    emailProvider: c.emailProvider,
    emailFrom: c.emailFrom,
    hasEmailApiKey: Boolean(c.emailApiKey),
    defaultChannel: c.defaultChannel,
  };
}

async function readConnectionsJson(): Promise<StoreConnections> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoreConnections>;
    return {
      emailProvider: parsed.emailProvider ?? EMPTY.emailProvider,
      emailFrom: parsed.emailFrom ?? "",
      emailApiKey: parsed.emailApiKey ?? "",
      defaultChannel: parsed.defaultChannel ?? "email",
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function writeConnectionsJson(next: StoreConnections): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600).catch(() => {});
}

export async function readConnections(_storeId?: string | null): Promise<StoreConnections> {
  const json = await readConnectionsJson();
  try {
    const { isSupabaseConfigured } = await import("@/lib/supabase");
    const { isEncryptionConfigured, overlaySecret } = await import("@/lib/secrets-crypto");
    if (!isSupabaseConfigured() || !isEncryptionConfigured()) return json;
    const sid = _storeId ?? null;
    if (!sid) return json;
    const { getStoreSecrets } = await import("@/lib/store-secrets");
    const db = await getStoreSecrets(sid).catch(() => null);
    if (!db) return json;
    return {
      ...json,
      emailApiKey: overlaySecret(json.emailApiKey, db?.email_api_key ?? ""),
    };
  } catch {
    return json;
  }
}

export interface WriteConnectionsOpts {
  storeId?: string | null;
}

export async function writeConnections(
  next: StoreConnections,
  opts: WriteConnectionsOpts = {},
): Promise<void> {
  const prevJson = await readConnectionsJson().catch(() => null);
  try {
    const { isSupabaseConfigured } = await import("@/lib/supabase");
    const { isEncryptionConfigured } = await import("@/lib/secrets-crypto");
    if (isSupabaseConfigured() && isEncryptionConfigured() && opts.storeId) {
      const { setStoreSecret } = await import("@/lib/store-secrets");
      if (next.emailApiKey) {
        const r = await setStoreSecret(opts.storeId, "email_api_key", next.emailApiKey).catch(() => null);
        if (r?.persistedToDb) {
          await writeConnectionsJson({ ...next, emailApiKey: "" });
          return;
        }
        const reverted = { ...next, emailApiKey: prevJson?.emailApiKey ?? "" };
        await writeConnectionsJson(reverted);
        throw new Error("No se pudo cifrar en DB (emailApiKey); no se guardó en disco. Reintenta.");
      }
    }
  } catch (e) {
    if (e instanceof Error && /No se pudo cifrar/.test(e.message)) throw e;
  }
  await writeConnectionsJson(next);
}
