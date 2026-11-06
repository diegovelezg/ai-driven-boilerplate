"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { resolveActiveStoreId } from "@/lib/tenant";
import {
  enrichDomain,
  invalidatePendingCache,
  pendingDomains,
  runEnrichment,
} from "@/lib/enrich";
import {
  finishRun,
  getLatestRun,
  hasConflict,
  startRun,
  type BackgroundRun,
} from "@/lib/background";
import { busyMessage } from "@/lib/operations";
import { formatNumber } from "@/lib/format";
import { createLogger } from "@/lib/log";

export interface StartEnrichState {
  ok: boolean;
  message: string;
  run: BackgroundRun | null;
}

/** Crea una corrida y la ejecuta en background (no bloquea ni se corta al navegar). */
export async function startEnrichmentAction(): Promise<StartEnrichState> {
  if (!isSupabaseConfigured()) {
    return { ok: false, message: "Falta SUPABASE_URL / SERVICE_ROLE en .env.local.", run: null };
  }
  try {
    const storeId = await resolveActiveStoreId();
    if (!storeId) return { ok: false, message: "Sin tienda.", run: null };

    // Lock por compatibilidad (Fase 3): el bulk frena ante otro bulk o
    // un puntual del mismo dominio; con copywriter convive.
    const conflict = await hasConflict(storeId, { kind: "enrichment" });
    if (conflict) {
      return { ok: false, message: busyMessage(conflict), run: conflict };
    }
    const pending = await pendingDomains(storeId);
    if (pending.length === 0) {
      return { ok: true, message: "No hay dominios pendientes.", run: await getLatestRun(storeId) };
    }
    // Tope por corrida (como morning cap 20): el resto va en la siguiente.
    // Sin esto, un catálogo B2B con cientos de dominios lanza cientos de
    // LLMs + fetches de una.
    const ENRICH_UI_CAP = 50;
    const batch = pending.slice(0, ENRICH_UI_CAP);
    const runId = await startRun(storeId, "enrichment", "Enriquecimiento", batch.length);
    // Background: arranca cuando la respuesta ya se envió; sobrevive la navegación.
    after(() => runEnrichment(runId, batch, { storeId }).finally(() => invalidatePendingCache(storeId)));
    revalidatePath("/customers");
    return {
      ok: true,
      message:
        batch.length < pending.length
          ? `Enriquecimiento iniciado (${formatNumber(batch.length)} de ${formatNumber(pending.length)} dominios; el resto en la próxima).`
          : `Enriquecimiento iniciado (${formatNumber(batch.length)} dominios).`,
      run: await getLatestRun(storeId),
    };
  } catch (e) {
    return { ok: false, message: `No se pudo iniciar: ${e instanceof Error ? e.message : "error"}`, run: null };
  }
}

/** Re-enriquece un dominio puntual (ignora que ya exista). Con corrida
 *  `enrich_single` acotada al dominio: suma a la cinta y evita el doble
 *  clic entre drawers. */
export async function reenrichDomainAction(
  domain: string,
): Promise<{ ok: boolean; message: string; run: BackgroundRun | null }> {
  if (!isSupabaseConfigured()) {
    return { ok: false, message: "Falta Supabase en .env.local.", run: null };
  }
  const log = createLogger("enrich");
  const storeId = await resolveActiveStoreId();
  let runId: string | null = null;
  if (storeId) {
    const conflict = await hasConflict(storeId, { kind: "enrich_single", scopeKind: "domain", scopeId: domain });
    if (conflict) return { ok: false, message: busyMessage(conflict), run: conflict };
    try {
      runId = await startRun(storeId, "enrich_single", "Re-enriquecimiento", 1, {
        scopeKind: "domain",
        scopeId: domain,
      });
    } catch (e) {
      log(`single ${domain} startRun falló: ${e instanceof Error ? e.message : e}`);
    }
  }
  try {
    const r = await enrichDomain(domain, true);
    if (runId) {
      await finishRun(
        runId,
        r === "failed"
          ? { status: "error", processed: 0, failed: 1, error: "No se pudo acceder al sitio." }
          : { status: "done", processed: 1, failed: 0, summary: "Actualizado.", pulseState: "active" },
      ).catch((e) => log(`single ${domain} finishRun falló: ${e instanceof Error ? e.message : e}`));
    }
    if (r === "failed") return { ok: false, message: "No se pudo acceder al sitio.", run: null };
    revalidatePath("/customers");
    return { ok: true, message: "Actualizado.", run: runId && storeId ? await getLatestRun(storeId).catch(() => null) : null };
  } catch (e) {
    const message = e instanceof Error ? e.message : "error";
    if (runId) {
      await finishRun(runId, { status: "error", processed: 0, failed: 1, error: message }).catch(() => {});
    }
    return { ok: false, message, run: null };
  }
}
