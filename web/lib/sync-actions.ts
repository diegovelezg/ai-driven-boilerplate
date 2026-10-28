"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { createLogger } from "@/lib/log";
import { ensureStore } from "@/lib/sync";
import { runSyncOnce } from "@/lib/sync-runner";
import {
  hasConflict,
  type BackgroundRun,
} from "@/lib/background";
import { busyMessage } from "@/lib/operations";

const log = createLogger("sync");

export interface SyncState {
  ok: boolean;
  message: string;
  run: BackgroundRun | null;
}

/** Sync manual: ejecución directa en `after()` (respuesta <200ms).
 *  Sin cola: `runSyncOnce` reclama slot atómico, escribe la cinta,
 *  recalibra post-sync y encadena la mañana según `withMorning`. */
export async function syncCustomersAction(): Promise<SyncState> {
  const conn = await readConnections();
  if (!conn.medusaUrl || !conn.medusaToken) {
    return { ok: false, message: "Sin conexión a Medusa (Settings).", run: null };
  }
  if (!isSupabaseConfigured()) {
    return { ok: false, message: "Falta SUPABASE_URL / SERVICE_ROLE en .env.local.", run: null };
  }
  const medusaUrl = conn.medusaUrl;
  const token = conn.medusaToken;
  try {
    // La primera sync crea la tienda; sin ella no hay nada que correr.
    const storeId =
      (await resolveStoreId(medusaUrl)) ?? (await ensureStore(medusaUrl, token));

    // `sync` bloquea todo (matriz issue #16): nombra el conflicto en vez
    // del genérico "ya hay un proceso".
    const conflict = await hasConflict(storeId, { kind: "sync" });
    if (conflict) {
      return { ok: false, message: busyMessage(conflict), run: conflict };
    }
    // Sin cola: se ejecuta en `after()` (la respuesta no espera).
    // `runSyncOnce` es idempotente por slot: si el cron lo está corriendo,
    // este reclama null y el `hasConflict` de arriba ya avisó.
    // Se devuelve run:null a propósito: `getLatestRun` aquí leería la corrida
    // ANTERIOR (el `after()` aún no reclamó slot) y el cliente seguiría un run
    // rancio. La corrida real aparece vía el poll de la cinta (≤6s).
    after(() => {
      runSyncOnce(storeId, medusaUrl, {
        version: conn.medusaVersion || "v1",
        token,
        withMorning: false,
      }).catch((e) => log(`run error ${e instanceof Error ? e.message : "error"}`));
    });
    revalidatePath("/customers");
    return { ok: true, message: "Sincronización iniciada (progreso abajo a la derecha).", run: null };
  } catch (e) {
    return {
      ok: false,
      message: `Sync falló: ${e instanceof Error ? e.message : "error"}`,
      run: null,
    };
  }
}
