"use server";

import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { syncStoreFromMedusa } from "@/lib/sync";

export interface SyncState {
  ok: boolean;
  message: string;
}

export async function syncCustomersAction(): Promise<SyncState> {
  const conn = await readConnections();
  if (!conn.medusaUrl || !conn.medusaToken) {
    return { ok: false, message: "Sin conexión a Medusa (Settings)." };
  }
  if (!isSupabaseConfigured()) {
    return { ok: false, message: "Falta SUPABASE_URL / SERVICE_ROLE en .env.local." };
  }
  try {
    const s = await syncStoreFromMedusa(
      conn.medusaUrl,
      conn.medusaVersion || "v1",
      conn.medusaToken,
    );
    revalidatePath("/customers");
    return {
      ok: true,
      message: `Sync ok: ${s.customers} customers, ${s.orders} orders (${s.markets} markets, ${s.channels} channels).`,
    };
  } catch (e) {
    return { ok: false, message: `Sync falló: ${e instanceof Error ? e.message : "error"}` };
  }
}
