"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { runScout } from "@/lib/scout";
import {
  getLatestRun,
  hasRunningRun,
  startRun,
  type BackgroundRun,
} from "@/lib/background";

export interface StartScoutState {
  ok: boolean;
  message: string;
  run: BackgroundRun | null;
}

/** Crea una corrida scout y la ejecuta en background (no bloquea la UI). */
export async function startScoutAction(): Promise<StartScoutState> {
  const conn = await readConnections();
  if (!conn.medusaUrl) {
    return { ok: false, message: "Sin conexión a Medusa (Settings).", run: null };
  }
  if (!isSupabaseConfigured()) {
    return { ok: false, message: "Falta SUPABASE_URL / SERVICE_ROLE en .env.local.", run: null };
  }
  try {
    const storeId = await resolveStoreId(conn.medusaUrl);
    if (!storeId) return { ok: false, message: "Tienda sin sincronizar.", run: null };

    if (await hasRunningRun(storeId)) {
      return { ok: true, message: "Ya hay una corrida en curso.", run: await getLatestRun(storeId) };
    }
    const runId = await startRun(storeId, "scout", "Scout", 0);
    after(() => runScout(runId, storeId));
    revalidatePath("/customers");
    return { ok: true, message: "Scout iniciado.", run: await getLatestRun(storeId) };
  } catch (e) {
    return { ok: false, message: `No se pudo iniciar: ${e instanceof Error ? e.message : "error"}`, run: null };
  }
}
