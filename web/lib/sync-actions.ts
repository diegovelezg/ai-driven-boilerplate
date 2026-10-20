"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { createLogger } from "@/lib/log";
import { ensureStore, syncStoreFromMedusa, SYNC_TOTAL } from "@/lib/sync";
import { formatNumber } from "@/lib/format";
import { recalibrateWithRun } from "@/lib/profile-recalibrate/service";
import {
  advanceRun,
  finishRun,
  getLatestRun,
  hasConflict,
  startRun,
  type BackgroundRun,
} from "@/lib/background";
import { busyMessage } from "@/lib/operations";

const log = createLogger("sync");

export interface SyncState {
  ok: boolean;
  message: string;
  run: BackgroundRun | null;
}

/** Encola un sync (el worker lo ejecuta): respuesta <200ms, sin `after()`. */
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
    // La primera sync crea la tienda; sin ella no hay job que encolar.
    const storeId =
      (await resolveStoreId(medusaUrl)) ?? (await ensureStore(medusaUrl, token));

    // `sync` bloquea todo (matriz issue #16): nombra el conflicto en vez
    // del genérico "ya hay un proceso".
    const conflict = await hasConflict(storeId, { kind: "sync" });
    if (conflict) {
      return { ok: false, message: busyMessage(conflict), run: conflict };
    }
    // Vía jobs (worker dedicado): la cinta (`background_runs`) la escribe el
    // worker al ejecutar; aquí solo se encola.
    try {
      const { enqueueJob } = await import("@/lib/jobs");
      await enqueueJob(storeId, "sync", {
        payload: { withMorning: false, reason: "manual" },
      });
      log(`sync encolado store=${storeId}`);
      revalidatePath("/customers");
      return { ok: true, message: "Sincronización encolada (la ejecuta el worker).", run: await getLatestRun(storeId) };
    } catch (e) {
      // DB sin migrar: fallback legacy (`after()`, como antes).
      log(`jobs no disponible, fallback legacy: ${e instanceof Error ? e.message : "error"}`);
    }
    const runId = await startRun(storeId, "sync", "Sincronización", SYNC_TOTAL);
    log(`run ${runId} start`);
    after(async () => {
      try {
        const s = await syncStoreFromMedusa(medusaUrl, conn.medusaVersion || "v1", token, {
          onProgress: (p) =>
            advanceRun(runId, { processed: p.processed, failed: 0, current: p.current }),
        });
        await finishRun(runId, {
          status: "done",
          processed: SYNC_TOTAL,
          failed: 0,
          summary: `${formatNumber(s.customers)} customers, ${formatNumber(s.orders)} orders (test excl: ${formatNumber(s.excludedTestOrders)}, inválidas excl: ${formatNumber(s.excludedInvalidOrders)})`,
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
