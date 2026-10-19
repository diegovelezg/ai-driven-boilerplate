"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { runStrategist } from "@/lib/strategist";
import { runCopywriter } from "@/lib/copywriter";
import { runDispatcher } from "@/lib/dispatcher";
import { runAnalyst } from "@/lib/analyst";
import {
  busyMessage,
  getLatestRun,
  hasConflict,
  startRun,
  type BackgroundRun,
} from "@/lib/background";

export interface StartRetentionState {
  ok: boolean;
  message: string;
  run: BackgroundRun | null;
}

async function startWorker(
  kind: string,
  label: string,
  total: number,
  work: (runId: string, storeId: string) => Promise<void>,
): Promise<StartRetentionState> {
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
    // Lock por compatibilidad (issue #16 Fase 3): solo lo incompatible
    // frena; el resto corre en paralelo y suma su chip a la cinta.
    const conflict = await hasConflict(storeId, { kind });
    if (conflict) {
      return { ok: false, message: busyMessage(conflict), run: conflict };
    }
    const runId = await startRun(storeId, kind, label, total);
    after(() => work(runId, storeId));
    revalidatePath("/review");
    return { ok: true, message: `${label} iniciado.`, run: await getLatestRun(storeId) };
  } catch (e) {
    return { ok: false, message: `No se pudo iniciar: ${e instanceof Error ? e.message : "error"}`, run: null };
  }
}

export async function startStrategistAction(): Promise<StartRetentionState> {
  return startWorker("strategist", "Estratega", 0, (runId, storeId) => runStrategist(runId, storeId));
}

export async function startCopywriterAction(): Promise<StartRetentionState> {
  return startWorker("copywriter", "Copywriter", 0, (runId, storeId) => runCopywriter(runId, storeId));
}

export async function startDispatcherAction(): Promise<StartRetentionState> {
  return startWorker("dispatcher", "Dispatcher", 0, (runId, storeId) => runDispatcher(runId, storeId));
}

export async function startAnalystAction(): Promise<StartRetentionState> {
  return startWorker("analyst", "Analyst", 0, (runId, storeId) => runAnalyst(runId, storeId));
}
