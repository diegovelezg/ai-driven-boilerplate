// Worker dedicado (issue #24): mismo repo/imagen que `web`, distinto comando
// (`npm run worker`). Hace poll de `jobs` con service_role, ejecuta el código
// actual fuera de contexto request/`after()`, y actualiza `background_runs`
// (la cinta sigue siendo solo lectura).
//
// Uso:
//   npm run worker            # poll continuo (prod: servicio aparte en compose/Coolify)
//   npm run worker -- --once  # 1 pasada (cron externo / debug)
//   npm run worker -- --poll-ms=5000 --kinds=sync,morning
import { claimNextJob, completeJob, failJob, reapStaleJobs, touchJob, type Job } from "@/lib/jobs";
import { parseWorkerArgs } from "@/lib/worker-args";
import { createLogger } from "@/lib/log";

const log = createLogger("worker");

/** Conflicto benigno: el trabajo lo cubre la corrida en curso (legacy omitía
 *  en vez de fallar). Se completa el job como done sin run propio. */
function skipConflict(job: Job, what: string): null {
  log(`job ${job.id} ${what} omitido (slot ocupado: en curso)`);
  return null;
}

async function dispatch(job: Job): Promise<string | null> {
  switch (job.kind) {
    case "sync": {
      const { resolveSyncTarget, runSyncOnce } = await import("@/lib/sync-runner");
      const target = await resolveSyncTarget(job.storeId);
      if (!target) throw new Error("Sin conexión Medusa para esta tienda (Settings).");
      return runSyncOnce(job.storeId, target.medusaUrl, {
        version: target.version,
        token: target.token,
        withMorning: (job.payload.withMorning as boolean | undefined) ?? true,
      });
    }
    case "morning": {
      const { runMorningPipeline } = await import("@/lib/morning-run");
      await runMorningPipeline(job.storeId);
      return null;
    }
    case "enrichment": {
      const { pendingDomains, runEnrichment, invalidatePendingCache } = await import("@/lib/enrich");
      const { claimRunSlot } = await import("@/lib/background");
      const domains = ((job.payload.domains as string[] | undefined) ?? null) ?? (await pendingDomains(job.storeId));
      if (domains.length === 0) return null;
      const runId = await claimRunSlot(job.storeId, "enrichment", "Enriquecimiento", domains.length);
      if (!runId) return skipConflict(job, "enrichment");
      try {
        await runEnrichment(runId, domains, { storeId: job.storeId });
      } finally {
        invalidatePendingCache(job.storeId);
      }
      return runId;
    }
    case "scout":
    case "strategist":
    case "copywriter":
    case "prospect": {
      const { claimRunSlot } = await import("@/lib/background");
      const labelMap: Record<string, string> = {
        scout: "Scout",
        strategist: "Estratega",
        copywriter: "Copywriter",
        prospect: "Prospección",
      };
      const runId = await claimRunSlot(job.storeId, job.kind, labelMap[job.kind] ?? job.kind, 0);
      if (!runId) return skipConflict(job, job.kind);
      if (job.kind === "scout") {
        const { runScout } = await import("@/lib/scout");
        await runScout(runId, job.storeId);
      } else if (job.kind === "strategist") {
        const { runStrategist } = await import("@/lib/strategist");
        await runStrategist(runId, job.storeId);
      } else if (job.kind === "copywriter") {
        const { runCopywriter } = await import("@/lib/copywriter");
        await runCopywriter(runId, job.storeId, { limit: 10 });
      } else {
        const { runProspect } = await import("@/lib/prospect");
        await runProspect(runId, job.storeId, { queries: 2, perQuery: 5 });
      }
      return runId;
    }
    default:
      throw new Error(`Job kind desconocido: ${String((job as { kind: unknown }).kind)}`);
  }
}

async function handleOne(kinds?: string[]): Promise<boolean> {
  let job: Job | null = null;
  try {
    job = await claimNextJob(kinds as Job["kind"][] | undefined);
  } catch (e) {
    // Sin tabla `jobs` (DB sin migrar): no crashear el loop, solo esperar.
    log(`claim omitido: ${e instanceof Error ? e.message : "error"}`);
    return false;
  }
  if (!job) return false;
  log(`job ${job.id} ${job.kind} store=${job.storeId} attempt=${job.attempts} start`);
  // Heartbeat del job durante dispatch largos (sync+morning con LLM >30min):
  // sin esto el reap lo re-encola mientras el original sigue corriendo.
  const heartbeat = setInterval(() => {
    touchJob(job.id).catch(() => {});
  }, 60_000);
  try {
    const runId = await dispatch(job);
    await completeJob(job.id, runId).catch(() => {});
    log(`job ${job.id} done`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    await failJob(job.id, msg, job.attempts, job.maxAttempts).catch(() => {});
    log(`job ${job.id} error ${msg}`);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

async function main(): Promise<void> {
  const { once, pollMs, kinds, unknownKinds } = parseWorkerArgs(process.argv.slice(2), process.env.WORKER_POLL_MS);
  if (unknownKinds.length > 0) {
    log(`kinds desconocidos ignorados: ${unknownKinds.join(",")} (válidos: sync,morning,enrichment,scout,strategist,copywriter,prospect)`);
  }
  if (kinds !== undefined && kinds.length === 0) {
    console.error("[worker] --kinds sin ningún kind válido: no se reclamaría nada. Revisa el flag.");
    process.exit(1);
  }
  const { isSupabaseConfigured } = await import("@/lib/supabase");
  if (!isSupabaseConfigured()) {
    console.error("[worker] Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  log(`start pollMs=${pollMs} kinds=${kinds?.join(",") ?? "all"}${once ? " once" : ""}`);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Redeploy a mitad de job: los `running` colgados se re-encolan, no eternos.
  await reapStaleJobs().catch(() => {});
  do {
    const worked = await handleOne(kinds).catch((e) => {
      log(`loop error: ${e instanceof Error ? e.message : "error"}`);
      return false;
    });
    if (once) break;
    if (stopped) break;
    await new Promise((r) => setTimeout(r, worked ? 200 : pollMs));
    // Reap oportunista cada ciclo lento (barato: 1 select).
    if (!worked) await reapStaleJobs().catch(() => {});
    if (stopped) break;
  } while (!stopped);
  log("stop");
}

// Solo corre al invocar `tsx worker.ts` (no al importar en tests).
if (require.main === module) {
  main().catch((e) => {
    console.error("[worker] fatal", e);
    process.exit(1);
  });
}
