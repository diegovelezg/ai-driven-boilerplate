// Núcleo encolable del sync (issue #24): función pura de worker, sin
// `after()`, sin cookies, sin redirect. La usan el worker dedicado y los
// fallbacks legacy (login/sync-button cuando `jobs` aún no existe).
import { advanceRun, claimRunSlot, finishRun } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { formatNumber } from "@/lib/format";
import { ensureStore, syncStoreFromPlatform, SYNC_TOTAL } from "@/lib/sync";
import { isConnectorSupported } from "@/lib/connectors";
import type { ConnectorPlatform } from "@/lib/connectors/types";
import type { MedusaVersion } from "@/lib/medusa";

const log = createLogger("sync");

export interface SyncRunnerOpts {
  version?: MedusaVersion | string;
  token: string;
  /** Plataforma del conector (default medusa; shopify/woo lanzan "sin backend"). */
  platform?: ConnectorPlatform;
  /** Tras el sync, corre la cadena de mañana con la BD cacheada. */
  withMorning?: boolean;
}

/** Ejecuta 1 sync completo + morning opcional. Solo el worker la llama en prod.
 *  Devuelve el run id, o `null` si el slot estaba ocupado (el trabajo lo cubre
 *  la corrida en curso: el caller completa el job como omitido, no como fallo). */
export async function runSyncOnce(storeId: string, shopUrl: string, opts: SyncRunnerOpts): Promise<string | null> {
  const runId = await claimRunSlot(storeId, "sync", "Sincronización", SYNC_TOTAL);
  if (!runId) {
    log(`run omitido store=${storeId} (slot ocupado: sync en curso)`);
    return null;
  }
  log(`run ${runId} start store=${storeId}`);
  try {
    const s = await syncStoreFromPlatform(opts.platform ?? "medusa", shopUrl, opts.version ?? "v1", opts.token, {
      onProgress: (p) => advanceRun(runId, { processed: p.processed, failed: 0, current: p.current }),
    });
    await finishRun(runId, {
      status: "done",
      processed: SYNC_TOTAL,
      failed: 0,
      summary: `${formatNumber(s.customers)} customers, ${formatNumber(s.orders)} orders, ${formatNumber(s.products)} productos (test excl: ${formatNumber(s.excludedTestOrders)}, inválidas excl: ${formatNumber(s.excludedInvalidOrders)})`,
    });
    log(`run ${runId} done`);
    try {
      const { recalibrateWithRun } = await import("@/lib/profile-recalibrate/service");
      await recalibrateWithRun(storeId, "post-sync").catch((e) =>
        log(`recalibrate post-sync falló: ${e instanceof Error ? e.message : e}`),
      );
    } catch {
      // Nunca rompe el sync.
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    await finishRun(runId, { status: "error", processed: 0, failed: 0, error: msg });
    log(`run ${runId} error ${msg}`);
    throw e;
  }
  if (opts.withMorning !== false) {
    try {
      const { runMorningPipeline } = await import("@/lib/morning-run");
      await runMorningPipeline(storeId);
    } catch (e) {
      log(`morning omitido: ${e instanceof Error ? e.message : "error"}`);
    }
  }
  return runId;
}

export interface SyncTarget {
  /** URL canónica de la tienda (normalizada). */
  shopUrl: string;
  /** @deprecated Alias de `shopUrl` (callers legacy Medusa). */
  medusaUrl: string;
  version: MedusaVersion;
  token: string;
  platform: ConnectorPlatform;
}

/** Resuelve credenciales por tienda para el worker (sin request). */
export async function resolveSyncTarget(
  storeId: string,
): Promise<SyncTarget | null> {
  try {
    const { readConnections } = await import("@/lib/store");
    const conn = await readConnections(storeId);
    if (!isConnectorSupported(conn.platform)) return null;
    if (conn.platform !== "medusa") return null;
    if (!conn.medusaUrl || !conn.medusaToken) return null;
    // Primera sync: la tienda puede no existir aún por URL; se crea aquí.
    return {
      shopUrl: conn.medusaUrl,
      medusaUrl: conn.medusaUrl,
      version: conn.medusaVersion || "v1",
      token: conn.medusaToken,
      platform: conn.platform,
    };
  } catch {
    return null;
  }
}

/** Asegura storeId desde URL (el worker no tiene cookies ni `?store=`). */
export async function ensureStoreForSync(
  rawShopUrl: string,
  token: string,
  platform: ConnectorPlatform = "medusa",
): Promise<string | null> {
  try {
    const { resolveStoreId } = await import("@/lib/customers-db");
    return (await resolveStoreId(rawShopUrl, platform).catch(() => null)) ?? (await ensureStore(rawShopUrl, token, platform));
  } catch {
    return null;
  }
}
