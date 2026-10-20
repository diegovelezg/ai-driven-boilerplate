// Worker cron (sin cola): ejecuta el pipeline por tienda y termina.
// La web corre `runSyncOnce` directo en `after()`; esto es solo para el
// programador externo (cron Coolify) y corridas manuales.
//
// Uso:
//   npm run worker -- --once --kinds=sync,morning            # todas las medusa
//   npm run worker -- --once --kinds=sync --store=<uuid>      # una tienda
//   npm run worker -- --once --kinds=morning                  # solo mañana
import { parseWorkerArgs } from "@/lib/worker-args";
import { createLogger } from "@/lib/log";

const log = createLogger("worker");

async function listMedusaStores(filterStore?: string): Promise<string[]> {
  const { getSupabase } = await import("@/lib/supabase");
  const q = getSupabase().from("stores").select("id").eq("platform", "medusa");
  const { data, error } = filterStore
    ? await q.eq("id", filterStore)
    : await q.order("created_at", { ascending: true }).limit(100);
  if (error) throw new Error(`Stores read: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => String(r.id)).filter(Boolean);
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
    const runId = await runSyncOnce(storeId, target.medusaUrl, {
      version: target.version,
      token: target.token,
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

async function main(): Promise<void> {
  const { kinds, unknownKinds, store } = parseWorkerArgs(process.argv.slice(2), process.env.WORKER_POLL_MS);
  if (unknownKinds.length > 0) {
    log(`kinds desconocidos ignorados: ${unknownKinds.join(",")} (válidos: sync,morning)`);
  }
  if (kinds !== undefined && kinds.length === 0) {
    console.error("[worker] --kinds sin ningún kind válido: no se correría nada. Revisa el flag.");
    process.exit(1);
  }
  const { isSupabaseConfigured } = await import("@/lib/supabase");
  if (!isSupabaseConfigured()) {
    console.error("[worker] Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  const stores = await listMedusaStores(store);
  if (stores.length === 0) {
    console.error("[worker] Sin tiendas medusa (o --store inexistente).");
    process.exit(1);
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
  if (failed > 0) process.exit(1);
}

// Solo corre al invocar `tsx worker.ts` (no al importar en tests).
if (require.main === module) {
  main().catch((e) => {
    console.error("[worker] fatal", e);
    process.exit(1);
  });
}
