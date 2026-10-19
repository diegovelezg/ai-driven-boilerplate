"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { createLogger } from "@/lib/log";
import { ensureStore, syncStoreFromMedusa, SYNC_TOTAL } from "@/lib/sync";
import { recalibrateWithRun } from "@/lib/profile-recalibrate/service";
import {
  advanceRun,
  busyMessage,
  finishRun,
  getLatestRun,
  hasConflict,
  startRun,
  type BackgroundRun,
} from "@/lib/background";

const log = createLogger("sync");

export interface SyncState {
  ok: boolean;
  message: string;
  run: BackgroundRun | null;
}

/** Crea una corrida de sync y la ejecuta en background (misma cinta que el resto). */
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
  const version = conn.medusaVersion || "v1";
  try {
    // La primera sync crea la tienda; sin ella no hay run que registrar.
    const storeId =
      (await resolveStoreId(medusaUrl)) ?? (await ensureStore(medusaUrl, token));

    // `sync` bloquea todo (matriz issue #16): nombra el conflicto en vez
    // del genérico "ya hay un proceso".
    const conflict = await hasConflict(storeId, { kind: "sync" });
    if (conflict) {
      return { ok: false, message: busyMessage(conflict), run: conflict };
    }
    const runId = await startRun(storeId, "sync", "Sincronización", SYNC_TOTAL);
    log(`run ${runId} start`);
    after(async () => {
      try {
        const s = await syncStoreFromMedusa(medusaUrl, version, token, {
          onProgress: (p) =>
            advanceRun(runId, { processed: p.processed, failed: 0, current: p.current }),
        });
        await finishRun(runId, {
          status: "done",
          processed: SYNC_TOTAL,
          failed: 0,
          summary: `${s.customers} customers, ${s.orders} orders (test excl: ${s.excludedTestOrders}, inválidas excl: ${s.excludedInvalidOrders})`,
        });
        log(`run ${runId} done`);
        // Vigilante de perfil (#6): con datos frescos, si toca la revisión
        // semanal corre sola. Nunca rompe la sync: sus fallos quedan en su run.
        await recalibrateWithRun(storeId, "post-sync").catch((e) =>
          log(`recalibrate post-sync falló: ${e instanceof Error ? e.message : e}`),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "error";
        await finishRun(runId, {
          status: "error",
          processed: 0,
          failed: 0,
          error: msg,
        });
        log(`run ${runId} error ${msg}`);
      }
    });
    revalidatePath("/customers");
    return { ok: true, message: "Sincronización iniciada.", run: await getLatestRun(storeId) };
  } catch (e) {
    return {
      ok: false,
      message: `Sync falló: ${e instanceof Error ? e.message : "error"}`,
      run: null,
    };
  }
}
