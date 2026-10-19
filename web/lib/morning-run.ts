// Orquestador de mañana (issue UX: "actuar hoy" sin borrador en Inbox).
// Cadena secuencial tras el login: sync ya corrió antes; aquí
// enrichment (best-effort, acotado) → scout (auto-corre retention si las
// predicciones no son de hoy) → strategist (prioriza open con actuar) →
// copywriter (redacta prioritized sin borrador) → prospect (rellena
// "Empresas por contactar"). Cada paso conserva su
// propia corrida en `background_runs` (historial intacto) y es idempotente:
// re-ejecutar no duplica (scout upsert, strategist límite, copywriter salta
// busySignal/busyCustomer, prospect dedupe por URL). Best-effort: un paso
// que falla no tumba los siguientes ni el login.
import { getSupabase } from "@/lib/supabase";
import { hasConflict, startRun } from "@/lib/background";
import { createLogger } from "@/lib/log";

const log = createLogger("morning");

/** ¿Ya corrió la cadena hoy? Evita gastar LLM en cada login del día. */
async function morningAlreadyDone(storeId: string): Promise<boolean> {
  try {
    const db = getSupabase();
    const dayStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
    ).toISOString();
    const { data } = await db
      .from("background_runs")
      .select("kind,status,started_at")
      .eq("store_id", storeId)
      .in("kind", ["scout", "strategist", "copywriter", "prospect"])
      .gte("started_at", dayStart)
      .eq("status", "done")
      .limit(10);
    const kinds = new Set(((data ?? []) as Array<Record<string, unknown>>).map((r) => String(r.kind ?? "")));
    return kinds.has("scout") && kinds.has("strategist") && kinds.has("copywriter") && kinds.has("prospect");
  } catch {
    return false;
  }
}

async function step(
  storeId: string,
  kind: "enrichment" | "scout" | "strategist" | "copywriter" | "prospect",
  label: string,
  total: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  work: (runId: string, sid: string) => Promise<any>,
): Promise<boolean> {
  const db = getSupabase();
  void db;
  const { hasConflict: hc } = await import("@/lib/background");
  const conflict = await hc(storeId, { kind });
  if (conflict) {
    log(`paso ${kind} omitido (en curso: ${conflict.label ?? conflict.kind})`);
    return false;
  }
  const runId = await startRun(storeId, kind, label, total);
  try {
    await work(runId, storeId);
    return true;
  } catch (e) {
    // Los workers ya hacen finishRun(error) internos; si el throw sale
    // antes, se deja constancia sin tumbar la cadena.
    log(`paso ${kind} ERROR ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** Cadena completa post-sync. Llamar dentro de `after()` (no bloquea login). */
export async function runMorningPipeline(storeId: string): Promise<void> {
  if (await hasConflict(storeId, { kind: "sync" })) {
    log("morning omitido (sync en curso)");
    return;
  }
  if (await morningAlreadyDone(storeId)) {
    log("morning omitido (cadena de hoy ya done)");
    return;
  }
  // 1. Enriquecimiento acotado: mejora el brief del copywriter (empresa/
  // industria). Cap 20 para no alargar el login; el resto va bajo demanda.
  try {
    const { pendingDomains, runEnrichment, invalidatePendingCache } = await import("@/lib/enrich");
    const pending = await pendingDomains(storeId).catch(() => [] as string[]);
    const batch = pending.slice(0, 20);
    if (batch.length > 0) {
      await step(storeId, "enrichment", "Enriquecimiento", batch.length, (runId) =>
        runEnrichment(runId, batch, { storeId }).finally(() => invalidatePendingCache(storeId)),
      );
    }
  } catch (e) {
    log(`enrichment omitido: ${e instanceof Error ? e.message : e}`);
  }
  // 2-5. scout (auto-retention dentro) → strategist → copywriter → prospect.
  const { runScout } = await import("@/lib/scout");
  await step(storeId, "scout", "Scout", 0, (runId, sid) => runScout(runId, sid));
  const { runStrategist } = await import("@/lib/strategist");
  await step(storeId, "strategist", "Estratega", 0, (runId, sid) => runStrategist(runId, sid));
  const { runCopywriter } = await import("@/lib/copywriter");
  await step(storeId, "copywriter", "Copywriter", 0, (runId, sid) =>
    runCopywriter(runId, sid, { limit: 10 }),
  );
  const { runProspect } = await import("@/lib/prospect");
  await step(storeId, "prospect", "Prospección", 0, (runId, sid) =>
    runProspect(runId, sid, { queries: 2, perQuery: 5 }),
  );
  log("morning done");
}
