"use server";

// Acciones del vigilante de perfil (#6) para Settings: revisión manual y
// decisión por delta. La revisión corre en background con corrida visible
// `recalibrate` (MO único: el cliente la envuelve en `bg.start` y la cinta
// muestra el toast de progreso); la decisión aplica solo el slot aceptado,
// nunca toda la propuesta.
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { finishRun, getLatestRun, startRun, type BackgroundRun } from "@/lib/background";
import { decideDelta, recalibrateWithRun, runRecalibration } from "./service";
import type { ProfileSlot } from "./diff";

export interface RecalibrateState {
  ok: boolean;
  message: string;
  /** Corrida visible en la cinta (solo la revisión la devuelve). */
  run?: BackgroundRun | null;
}

async function currentStoreId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const conn = await readConnections();
  if (!conn.medusaUrl) return null;
  return resolveStoreId(conn.medusaUrl).catch(() => null);
}

/** Botón "Revisar mi perfil": dispara el vigilante saltando la cadencia.
 *  Corrida primero, trabajo en `after()`: el cliente recibe el run al
 *  instante y la cinta muestra el progreso del ~1 min de set. */
export async function runRecalibrationAction(): Promise<RecalibrateState> {
  const storeId = await currentStoreId();
  if (!storeId) {
    return { ok: false, message: "Conecta Medusa y sincroniza primero: aún no hay store." };
  }
  try {
    const runId = await startRun(storeId, "recalibrate", "Revisión de perfil", 1);
    after(async () => {
      try {
        const outcome = await runRecalibration(storeId, { source: "manual" });
        await finishRun(runId, {
          status: "done",
          processed: 1,
          failed: 0,
          summary: outcome.reason,
        });
      } catch (e) {
        await finishRun(runId, {
          status: "error",
          processed: 0,
          failed: 1,
          error: e instanceof Error ? e.message : "error",
        }).catch(() => undefined);
      }
      revalidatePath("/settings");
    });
    revalidatePath("/settings");
    return {
      ok: true,
      message: "Revisión de perfil iniciada (~1 min): sigue el progreso abajo a la derecha.",
      run: await getLatestRun(storeId).catch(() => null),
    };
  } catch {
    // Sin cinta (DB sin tabla/migración): camino legacy sin run visible.
    after(async () => {
      await recalibrateWithRun(storeId, "manual");
      revalidatePath("/settings");
    });
    return {
      ok: true,
      message:
        "Revisión de perfil en curso (~1 min): recarga esta página para ver la propuesta si hay drift.",
    };
  }
}

export interface DecideState {
  ok: boolean;
  message: string;
}

const SLOTS: ProfileSlot[] = [
  "archetype",
  "repurchase_cycle_days",
  "taxonomy_id",
  "buyer_type",
];

/** Acepta o rechaza UN delta de la propuesta pendiente. */
export async function decideProfileDeltaAction(
  proposalId: string,
  slot: string,
  accept: boolean,
): Promise<DecideState> {
  const storeId = await currentStoreId();
  if (!storeId) return { ok: false, message: "Sin store resuelto." };
  if (!SLOTS.includes(slot as ProfileSlot)) {
    return { ok: false, message: "Slot inválido." };
  }
  const result = await decideDelta(
    storeId,
    proposalId,
    slot as ProfileSlot,
    accept,
  );
  revalidatePath("/settings");
  if (!result.ok) return result;
  return {
    ok: true,
    message: accept ? "Cambio aplicado a tu perfil." : "Cambio descartado.",
  };
}
