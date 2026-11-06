// Worker cron (sin cola): ejecuta el pipeline de mañana por tienda.
// Dos modos:
//   - one-shot (default; prod = cron externo Coolify): una pasada y termina.
//     `npm run worker -- --once --kinds=morning` o corridas manuales.
//   - daemon interno (solo dev; `WORKER_SCHEDULE=1` sin `--once`): duerme hasta las
//     `WORKER_CRON_HOUR:WORKER_CRON_MINUTE` Lima (UTC-5 fijo, default 06:00),
//     corre la pasada y repite.
import { msUntilNextLimaRun, parseWorkerArgs, parseWorkerSchedule } from "@/lib/worker-args";
import { createLogger } from "@/lib/log";

const log = createLogger("worker");

async function listWorkerStores(filterStore?: string): Promise<string[]> {
  const { listStores } = await import("@/lib/customers-db");
  return listStores(filterStore);
}

async function runStore(storeId: string): Promise<void> {
  const { runMorningPipeline } = await import("@/lib/morning-run");
  await runMorningPipeline(storeId);
  log(`store=${storeId} morning done`);
}

/** Una pasada por todas las tiendas. Devuelve nº de fallos. */
async function runOnce(store: string | undefined, kinds: string[] | undefined): Promise<number> {
  const { isSupabaseConfigured } = await import("@/lib/supabase");
  if (!isSupabaseConfigured()) {
    throw new Error("Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  }
  {
    const { getSupabase } = await import("@/lib/supabase");
    const { checkSchema, schemaGapMessage } = await import("@/lib/schema-guard");
    const gaps = await checkSchema(getSupabase());
    if (gaps.length > 0) throw new Error(schemaGapMessage(gaps));
  }
  const stores = await listWorkerStores(store);
  if (stores.length === 0) {
    throw new Error("Sin tiendas (o --store inexistente).");
  }
  log(`start stores=${stores.length} kinds=${kinds?.join(",") ?? "morning"}`);
  let failed = 0;
  for (const sid of stores) {
    try {
      await runStore(sid);
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
    log(`kinds desconocidos ignorados: ${unknownKinds.join(",")} (válidos: morning)`);
  }
  if (kinds !== undefined && kinds.length === 0) {
    console.error("[worker] --kinds sin ningún kind válido: no se correría nada. Revisa el flag.");
    process.exit(1);
  }
  const schedule = parseWorkerSchedule(process.env);
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

if (require.main === module) {
  main().catch((e) => {
    console.error("[worker] fatal", e);
    process.exit(1);
  });
}
