"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import {
  enrichDomain,
  getLatestRun,
  hasRunningRun,
  pendingDomains,
  runEnrichment,
  startRun,
  type EnrichRunStatus,
} from "@/lib/enrich";

export interface StartEnrichState {
  ok: boolean;
  message: string;
  run: EnrichRunStatus | null;
}

/** Crea una corrida y la ejecuta en background (no bloquea ni se corta al navegar). */
export async function startEnrichmentAction(): Promise<StartEnrichState> {
  const conn = await readConnections();
  if (!conn.medusaUrl || !conn.medusaToken) {
    return { ok: false, message: "Sin conexión a Medusa (Settings).", run: null };
  }
  if (!isSupabaseConfigured()) {
    return { ok: false, message: "Falta SUPABASE_URL / SERVICE_ROLE en .env.local.", run: null };
  }
  try {
    const storeId = await resolveStoreId(conn.medusaUrl);
    if (!storeId) return { ok: false, message: "Tienda sin sincronizar.", run: null };

    if (await hasRunningRun(storeId)) {
      return { ok: true, message: "Ya hay un enriquecimiento en curso.", run: await getLatestRun(storeId) };
    }
    const pending = await pendingDomains(storeId);
    if (pending.length === 0) {
      return { ok: true, message: "No hay dominios pendientes.", run: await getLatestRun(storeId) };
    }
    const runId = await startRun(storeId, pending.length);
    // Background: arranca cuando la respuesta ya se envió; sobrevive la navegación.
    after(() => runEnrichment(runId, pending));
    revalidatePath("/customers");
    return {
      ok: true,
      message: `Enriquecimiento iniciado (${pending.length} dominios).`,
      run: await getLatestRun(storeId),
    };
  } catch (e) {
    return { ok: false, message: `No se pudo iniciar: ${e instanceof Error ? e.message : "error"}`, run: null };
  }
}

/** Re-enriquece un dominio puntual (ignora que ya exista). */
export async function reenrichDomainAction(
  domain: string,
): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseConfigured()) {
    return { ok: false, message: "Falta Supabase en .env.local." };
  }
  try {
    const r = await enrichDomain(domain, true);
    if (r === "failed") return { ok: false, message: "No se pudo acceder al sitio." };
    revalidatePath("/customers");
    return { ok: true, message: "Actualizado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "error" };
  }
}

/** Estado de la última corrida (para el polling de la UI). */
export async function getEnrichmentStatusAction(): Promise<EnrichRunStatus | null> {
  if (!isSupabaseConfigured()) return null;
  const conn = await readConnections();
  if (!conn.medusaUrl) return null;
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return null;
  return getLatestRun(storeId);
}
