"use server";

import { isSupabaseConfigured } from "@/lib/supabase";
import { resolveActiveStoreId } from "@/lib/tenant";
import { getActiveRuns, type BackgroundRun } from "@/lib/background";

/** Fuente de la cinta multi-run (issue #16 Fase 2): corridas en curso +
 *  últimas terminadas. El `dismiss` es cliente (localStorage por id). */
export async function getActiveRunsAction(): Promise<BackgroundRun[]> {
  if (!isSupabaseConfigured()) return [];
  const storeId = await resolveActiveStoreId();
  if (!storeId) return [];
  return getActiveRuns(storeId);
}
