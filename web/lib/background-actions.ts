"use server";

import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { getActiveRuns, type BackgroundRun } from "@/lib/background";

/** Fuente de la cinta multi-run (issue #16 Fase 2): corridas en curso +
 *  últimas terminadas. El `dismiss` es cliente (localStorage por id). */
export async function getActiveRunsAction(): Promise<BackgroundRun[]> {
  if (!isSupabaseConfigured()) return [];
  const conn = await readConnections();
  if (!conn.medusaUrl) return [];
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return [];
  return getActiveRuns(storeId);
}
