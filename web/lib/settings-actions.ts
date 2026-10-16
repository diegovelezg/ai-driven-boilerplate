"use server";

import { revalidatePath } from "next/cache";
import { medusaLogin, testMedusa } from "@/lib/medusa";
import type { MedusaVersion } from "@/lib/medusa";
import { readConnections, writeConnections } from "@/lib/store";
import type { Platform } from "@/lib/store";
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
    await writeConnections({
      ...prev,
      platform,
      shopifyStore: String(formData.get("shopifyStore") ?? "").trim(),
      shopifyToken: String(formData.get("shopifyToken") ?? "").trim(),
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
