import { readFile, writeFile, mkdir } from "node:fs/promises";
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

export async function readConnections(): Promise<StoreConnections> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY };
  }
}

export async function writeConnections(next: StoreConnections): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
}
