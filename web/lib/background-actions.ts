"use server";

import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { getLatestRun, type BackgroundRun } from "@/lib/background";

/** Estado de la última corrida en segundo plano (para el polling de la cinta global). */
export async function getBackgroundStatusAction(): Promise<BackgroundRun | null> {
  if (!isSupabaseConfigured()) return null;
  const conn = await readConnections();
  if (!conn.medusaUrl) return null;
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return null;
  return getLatestRun(storeId);
}
