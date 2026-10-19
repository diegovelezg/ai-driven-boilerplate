"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { findDuplicateGroups } from "@/lib/duplicates";
import { mergeCustomers } from "@/lib/merge";
import { formatNumber } from "@/lib/format";

export interface MergeState {
  ok: boolean;
  message: string;
}

export interface MergeAllState extends MergeState {
  merged: number;
  failed: number;
  total: number;
}

/**
 * Tras combinar fichas las sesiones/ritmos cambian (órdenes movidas):
 * se re-ejecuta retention + scout + strategist en fondo para que el motor
 * re-analice con el historial unificado. Best-effort: lo pesado (copywriter
 * LLM) queda para la mañana; aquí solo se reabre lo accionable.
 */
function triggerPostMergeRefresh(storeId: string): void {
  after(async () => {
    try {
      const { createLogger } = await import("@/lib/log");
      const log = createLogger("merge");
      const { runRetentionModel } = await import("@/lib/retention");
      const r = await runRetentionModel(storeId, new Date());
      log(`post-merge retention predicted=${r.predicted} actuar=${r.actuar}`);
      const { startRun } = await import("@/lib/background");
      const { runScout } = await import("@/lib/scout");
      const { runStrategist } = await import("@/lib/strategist");
      const scoutId = await startRun(storeId, "scout", "Scout", 0);
      await runScout(scoutId, storeId);
      const stratId = await startRun(storeId, "strategist", "Estratega", 0);
      await runStrategist(stratId, storeId);
      // Copywriter acotado: sin esto la señal nueva amanece sin borrador
      // hasta la mañana siguiente (hueco visto en Review: riesgo sin mensaje).
      const { runCopywriter } = await import("@/lib/copywriter");
      const copyId = await startRun(storeId, "copywriter", "Copywriter", 0);
      await runCopywriter(copyId, storeId, { limit: 5 });
      log("post-merge refresh done");
    } catch {
      // Best-effort: el error queda en el log del worker, no tumba el merge.
    }
  });
}

/** Combina todos los grupos de duplicados en una pasada. Sigue aunque un caso falle. */
export async function mergeAllDuplicatesAction(): Promise<MergeAllState> {
  if (!isSupabaseConfigured())
    return { ok: false, message: "Supabase no configurado.", merged: 0, failed: 0, total: 0 };
  const conn = await readConnections();
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return { ok: false, message: "Tienda sin sincronizar.", merged: 0, failed: 0, total: 0 };
  try {
    const groups = await findDuplicateGroups(storeId);
    if (groups.length === 0)
      return { ok: true, message: "No hay casos pendientes.", merged: 0, failed: 0, total: 0 };
    // Run propio para la cinta: sin esto el merge (y su re-análisis) es
    // invisible — el poll solo ve background_runs.
    const { startRun, advanceRun, finishRun } = await import("@/lib/background");
    let runId: string | null = null;
    try {
      runId = await startRun(storeId, "merge", "Combinar duplicados", groups.length);
    } catch {
      runId = null;
    }
    let merged = 0;
    let failed = 0;
    let removed = 0;
    let movedOrders = 0;
    const errors: string[] = [];
    for (const g of groups) {
      try {
        const r = await mergeCustomers(
          storeId,
          g.rows.map((r) => r.dbId),
        );
        merged += 1;
        removed += r.removed;
        movedOrders += r.movedOrders;
      } catch (e) {
        failed += 1;
        if (errors.length < 3) errors.push(`${g.email}: ${e instanceof Error ? e.message : "error"}`);
      }
      if (runId) {
        try {
          await advanceRun(runId, { processed: merged + failed, failed, current: null });
        } catch {
          // Progreso best-effort.
        }
      }
    }
    revalidatePath("/customers/duplicates");
    revalidatePath("/customers");
    if (runId) {
      try {
        await finishRun(runId, {
          status: merged === 0 ? "error" : "done",
          processed: merged,
          failed,
          summary:
            merged === 0
              ? `No se pudo combinar ningún caso. ${errors.join(" · ")}`
              : `Combinados ${formatNumber(merged)}/${formatNumber(groups.length)} casos · ${formatNumber(movedOrders)} ${movedOrders === 1 ? "orden" : "órdenes"} movidas`,
        });
      } catch {
        // Cierre best-effort.
      }
    }
    if (merged === 0)
      return {
        ok: false,
        message: `No se pudo combinar ningún caso (${formatNumber(failed)} fallo${failed === 1 ? "" : "s"}). ${errors.join(" · ")}`,
        merged,
        failed,
        total: groups.length,
      };
    const tail = failed > 0 ? ` · ${formatNumber(failed)} fallo${failed === 1 ? "" : "s"}: ${errors.join(" · ")}` : "";
    triggerPostMergeRefresh(storeId);
    return {
      ok: failed === 0,
      message: `Combinados ${formatNumber(merged)}/${formatNumber(groups.length)} casos · ${formatNumber(removed)} ficha${removed === 1 ? "" : "s"} eliminada${removed === 1 ? "" : "s"} · ${formatNumber(movedOrders)} ${movedOrders === 1 ? "orden" : "órdenes"} movida${movedOrders === 1 ? "" : "s"}.${tail}`,
      merged,
      failed,
      total: groups.length,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "error",
      merged: 0,
      failed: 0,
      total: 0,
    };
  }
}

export async function mergeCustomersAction(dbIds: string[]): Promise<MergeState> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Supabase no configurado." };
  if (!Array.isArray(dbIds) || dbIds.length < 2) {
    return { ok: false, message: "Se necesitan al menos 2 fichas." };
  }
  const conn = await readConnections();
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return { ok: false, message: "Tienda sin sincronizar." };
  try {
    const { startRun, finishRun } = await import("@/lib/background");
    let runId: string | null = null;
    try {
      runId = await startRun(storeId, "merge", "Combinar duplicados", 1);
    } catch {
      runId = null;
    }
    const r = await mergeCustomers(storeId, dbIds);
    revalidatePath("/customers/duplicates");
    revalidatePath("/customers");
    if (runId) {
      try {
        await finishRun(runId, {
          status: "done",
          processed: 1,
          failed: 0,
          summary: `Combinadas ${formatNumber(r.removed + 1)} fichas · ${formatNumber(r.movedOrders)} órdenes movidas.`,
        });
      } catch {
        // Cierre best-effort.
      }
    }
    triggerPostMergeRefresh(storeId);
    return {
      ok: true,
      message: `Combinadas ${formatNumber(r.removed + 1)} fichas · ${formatNumber(r.movedOrders)} órdenes movidas.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "error" };
  }
}
