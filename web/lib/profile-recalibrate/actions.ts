"use server";

// Acciones del vigilante de perfil (#6) para Settings: revisión manual y
// decisión por delta. La revisión corre en background (el set tarda ~1 min);
// la decisión aplica solo el slot aceptado, nunca toda la propuesta.
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { decideDelta, recalibrateWithRun } from "./service";
import type { ProfileSlot } from "./diff";

export interface RecalibrateState {
  ok: boolean;
  message: string;
}

async function currentStoreId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const conn = await readConnections();
  if (!conn.medusaUrl) return null;
  return resolveStoreId(conn.medusaUrl).catch(() => null);
}

/** Botón "Revisar mi perfil": dispara el vigilante saltando la cadencia.
 *  El set tarda ~1 min en background: el revalidate de after() solo refresca
 *  la PRÓXIMA visita, así que el copy pide recargar (sin polling en v1). */
export async function runRecalibrationAction(): Promise<RecalibrateState> {
  const storeId = await currentStoreId();
  if (!storeId) {
    return { ok: false, message: "Conecta Medusa y sincroniza primero: aún no hay store." };
  }
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
