// Worker cron (sin cola): ejecuta el pipeline por tienda.
// Dos modos:
//   - one-shot (default; prod = cron externo Coolify): una pasada y termina.
//     `npm run worker -- --once --kinds=sync,morning` o corridas manuales.
//   - daemon interno (solo dev; `WORKER_SCHEDULE=1` sin `--once`): duerme hasta las
//     `WORKER_CRON_HOUR:WORKER_CRON_MINUTE` Lima (UTC-5 fijo, default 06:00),
//     corre la pasada y repite. No necesita cron externo de Coolify.
// La web corre `runSyncOnce` directo en `after()`; el worker es el programador.
//
// Uso:
//   npm run worker -- --once --kinds=sync,morning            # todas las medusa
//   npm run worker -- --once --kinds=sync --store=<uuid>      # una tienda
//   npm run worker -- --once --kinds=morning                  # solo mañana
//   WORKER_SCHEDULE=1 npm run worker -- --kinds=sync,morning  # daemon 06:00 Lima
import { msUntilNextLimaRun, parseWorkerArgs, parseWorkerSchedule } from "@/lib/worker-args";
import { createLogger } from "@/lib/log";

const log = createLogger("worker");

async function listSyncStores(filterStore?: string): Promise<string[]> {
  const { SUPPORTED_CONNECTORS } = await import("@/lib/connectors");
  const { listStoresByPlatform } = await import("@/lib/customers-db");
  return listStoresByPlatform(SUPPORTED_CONNECTORS, filterStore);
}

async function runStore(storeId: string, kinds: string[] | undefined): Promise<void> {
  const wantSync = kinds === undefined || kinds.includes("sync");
  const wantMorning = kinds === undefined || kinds.includes("morning");
  if (wantSync) {
    const { resolveSyncTarget, runSyncOnce } = await import("@/lib/sync-runner");
    const target = await resolveSyncTarget(storeId);
    if (!target) {
      log(`store=${storeId} sin conexión, omitido`);
      return;
    }
    const runId = await runSyncOnce(storeId, target.shopUrl, {
      version: target.version,
      token: target.token,
      platform: target.platform,
      withMorning: wantMorning,
    });
    // null = slot ocupado (lo cubre la corrida en curso): omitido, no fallo.
    log(`store=${storeId} sync run=${runId ?? "omitido (en curso)"}`);
    return;
  }
  if (wantMorning) {
    const { runMorningPipeline } = await import("@/lib/morning-run");
    await runMorningPipeline(storeId);
    log(`store=${storeId} morning done`);
  }
}

/** Una pasada por todas las tiendas. Devuelve nº de fallos. */
async function runOnce(store: string | undefined, kinds: string[] | undefined): Promise<number> {
  const { isSupabaseConfigured } = await import("@/lib/supabase");
  if (!isSupabaseConfigured()) {
    throw new Error("Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  }
  // Gate de esquema (2026-10-21: web 9 migraciones por delante de prod):
  // fallar en rojo con el remedio exacto en vez de correr a medias y
  // llenar el log de "Could not find the table ... in the schema cache".
  {
    const { getSupabase } = await import("@/lib/supabase");
    const { checkSchema, schemaGapMessage } = await import("@/lib/schema-guard");
    const gaps = await checkSchema(getSupabase());
    if (gaps.length > 0) throw new Error(schemaGapMessage(gaps));
  }
  const stores = await listSyncStores(store);
  if (stores.length === 0) {
    throw new Error("Sin tiendas (o --store inexistente).");
  }
  log(`start stores=${stores.length} kinds=${kinds?.join(",") ?? "sync,morning"}`);
  let failed = 0;
  for (const sid of stores) {
    try {
      await runStore(sid, kinds);
    } catch (e) {
      failed += 1;
      log(`store=${sid} error ${e instanceof Error ? e.message : "error"}`);
    }
  }
  log(`done failed=${failed}`);
  return failed;
}

let shutdown = false;

/** Sleep interrumpible por SIGTERM/SIGINT (redeploy de Coolify). */
function sleepInterruptible(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || shutdown) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      clearInterval(check);
      resolve();
    }, ms);
    // Chequeo corto para despertar rápido ante SIGTERM sin busy-loop.
    const check = setInterval(() => {
      if (shutdown) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });
}

/** Daemon interno: corre a la hora Lima indicada y repite cada 24h. */
async function runDaemon(store: string | undefined, kinds: string[] | undefined, hour: number, minute: number): Promise<void> {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  log(`daemon interno activo (hora Lima ${hh}:${mm}): sin cron externo`);
  for (;;) {
    const waitMs = msUntilNextLimaRun(Date.now(), hour, minute);
    const nextIso = new Date(Date.now() + waitMs).toISOString();
    log(`próxima corrida ${nextIso} (en ${Math.round(waitMs / 60_000)}min)`);
    await sleepInterruptible(waitMs);
    if (shutdown) {
      log("daemon detenido (SIGTERM)");
      return;
    }
    try {
      const failed = await runOnce(store, kinds);
      if (failed > 0) log(`pasada con failed=${failed} (se reintenta mañana)`);
    } catch (e) {
      // Fatales (config/DB/descubrimiento) = deploy roto: salir con 1 para que
      // Coolify lo marque en rojo en vez de quedar verde sin correr nunca.
      // Fallos transitorios ya van por contador dentro de runOnce.
      if (isFatalWorkerError(e)) {
        console.error(`[worker] fatal ${e instanceof Error ? (e.stack ?? e.message) : "error"}`);
        process.exit(1);
      }
      log(`pasada error ${e instanceof Error ? e.message : "error"} (se reintenta mañana)`);
    }
  }
}

/** Errores que indican deploy roto (no transitorios): salir, no reintentar. */
function isFatalWorkerError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /Falta SUPABASE|Sin tiendas|Stores read|DB detrás del código/i.test(msg);
}

async function main(): Promise<void> {
  const { kinds, unknownKinds, store, once } = parseWorkerArgs(process.argv.slice(2), process.env.WORKER_POLL_MS);
  if (unknownKinds.length > 0) {
    log(`kinds desconocidos ignorados: ${unknownKinds.join(",")} (válidos: sync,morning)`);
  }
  if (kinds !== undefined && kinds.length === 0) {
    console.error("[worker] --kinds sin ningún kind válido: no se correría nada. Revisa el flag.");
    process.exit(1);
  }
  const schedule = parseWorkerSchedule(process.env);
  // `--once` siempre fuerza una pasada (corridas manuales + cron externo legacy).
  if (!once && schedule.enabled) {
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.on(sig, () => {
        shutdown = true;
      });
    }
    await runDaemon(store, kinds, schedule.hour, schedule.minute);
    return;
  }
  try {
    const failed = await runOnce(store, kinds);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error(`[worker] ${e instanceof Error ? e.message : "error"}`);
    process.exit(1);
  }
}

// Solo corre al invocar `tsx worker.ts` (no al importar en tests).
if (require.main === module) {
  main().catch((e) => {
    console.error("[worker] fatal", e);
    process.exit(1);
  });
}
