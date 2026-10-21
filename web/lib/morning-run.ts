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
import { hasConflict } from "@/lib/background";
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
  kind: "enrichment" | "scout" | "strategist" | "copywriter" | "prospect" | "brain",
  label: string,
  total: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  work: (runId: string, sid: string) => Promise<any>,
): Promise<boolean> {
  // Slot atómico (issue #24): check+insert en una transacción; entre réplicas
  // del worker el `hasConflict` → `startRun` clásico es TOCTOU y duplica runs.
  const { claimRunSlot } = await import("@/lib/background");
  const runId = await claimRunSlot(storeId, kind, label, total);
  if (!runId) {
    log(`paso ${kind} omitido (slot ocupado: el trabajo lo cubre la corrida en curso)`);
    return false;
  }
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
  // 1. Enriquecimiento completo: corre en CADA login si hay pendientes
  // (la cadena-done no lo frena). Solo frena si ya hay uno en curso.
  // Sin esto, los reintentos (intento 1/3) esperan al día siguiente aunque
  // el dueño entre 5 veces. Mejora el brief del copywriter
  // (empresa/industria). Corre en `after()` en fondo (no alarga el login).
  try {
    const { pendingDomains, runEnrichment, invalidatePendingCache } = await import("@/lib/enrich");
    const batch = await pendingDomains(storeId).catch(() => [] as string[]);
    if (batch.length > 0) {
      await step(storeId, "enrichment", "Enriquecimiento", batch.length, (runId) =>
        runEnrichment(runId, batch, { storeId }).finally(() => invalidatePendingCache(storeId)),
      );
    }
  } catch (e) {
    log(`enrichment omitido: ${e instanceof Error ? e.message : e}`);
  }
  // 0. TenantBrain diario (#25 Hito 1.3): 1 job/día, antes del loop.
  // Snapshot agnóstico en store_profiles.brain_json; lo leen writer/juez/prospect
  // con 1 query (sin N+1 por borrador). Best-effort: no tumba la cadena.
  try {
    await step(storeId, "brain", "TenantBrain", 1, async (runId, sid) => {
      const { computeTenantBrain, saveTenantBrain, getTenantBrain, isBrainFresh } = await import("@/lib/brain");
      const { finishRun } = await import("@/lib/background");
      const cur = await getTenantBrain(sid).catch(() => null);
      if (isBrainFresh(cur)) {
        await finishRun(runId, { status: "done", processed: 0, failed: 0, summary: "Brain fresco (<24h), sin recompute", pulseState: "paused" });
        log("brain fresco, sin recompute");
        return;
      }
      const brain = await computeTenantBrain(sid);
      await saveTenantBrain(sid, brain);
      let ticketTxt: string | null = null;
      try {
        const { formatMoney } = await import("@/lib/medusa");
        ticketTxt = brain.ticketP50 != null ? formatMoney(brain.ticketP50, brain.ticketCurrency) : null;
      } catch {
        ticketTxt = brain.ticketP50 != null ? String(Math.round(brain.ticketP50 / 100)) : null;
      }
      await finishRun(runId, {
        status: "done",
        processed: 1,
        failed: 0,
        summary: `Brain actualizado: top ${brain.topProductos[0]?.title?.slice(0, 40) ?? "sin top"} · ticket p50 ${ticketTxt ?? "?"}`,
        pulseState: "paused",
      });
      log(`brain done top=${brain.topProductos.length} ventana=${brain.ventanaMedianaDias} ticketP50=${ticketTxt ?? brain.ticketP50}`);
    });
  } catch (e) {
    log(`brain omitido: ${e instanceof Error ? e.message : e}`);
  }
  if (await morningAlreadyDone(storeId)) {
    log("morning omitido (cadena de hoy ya done)");
    return;
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
