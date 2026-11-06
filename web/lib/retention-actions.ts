"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { resolveActiveStoreId } from "@/lib/tenant";
import { runStrategist } from "@/lib/strategist";
import { runCopywriter } from "@/lib/copywriter";
import { runDispatcher } from "@/lib/dispatcher";
import { runAnalyst } from "@/lib/analyst";
import {
  getLatestRun,
  hasConflict,
  startRun,
  type BackgroundRun,
} from "@/lib/background";
import { busyMessage } from "@/lib/operations";

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
  if (!isSupabaseConfigured()) {
    return { ok: false, message: "Falta SUPABASE_URL / SERVICE_ROLE en .env.local.", run: null };
  }
  try {
    const storeId = await resolveActiveStoreId();
    if (!storeId) return { ok: false, message: "Sin tienda.", run: null };
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

// fallow-ignore-next-line unused-server-action -- wired on demand like startCopywriterAction
export async function startStrategistAction(): Promise<StartRetentionState> {
  return startWorker("strategist", "Estratega", 0, (runId, storeId) => runStrategist(runId, storeId));
}

export async function startCopywriterAction(): Promise<StartRetentionState> {
  return startWorker("copywriter", "Copywriter", 0, (runId, storeId) => runCopywriter(runId, storeId));
}

// fallow-ignore-next-line unused-server-action -- wired on demand like startCopywriterAction
export async function startDispatcherAction(): Promise<StartRetentionState> {
  return startWorker("dispatcher", "Dispatcher", 0, (runId, storeId) => runDispatcher(runId, storeId));
}

// fallow-ignore-next-line unused-server-action -- wired on demand like startCopywriterAction
export async function startAnalystAction(): Promise<StartRetentionState> {
  return startWorker("analyst", "Analyst", 0, (runId, storeId) => runAnalyst(runId, storeId));
}
