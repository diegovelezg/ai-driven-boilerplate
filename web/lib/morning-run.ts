// Orquestador de mañana.
// Cadena secuencial tras el login: enrichment (best-effort, acotado) → scout (auto-corre retention si las
// predicciones no son de hoy) → strategist (prioriza open con actuar) →
// copywriter (redacta prioritized sin borrador) → prospect (rellena
// "Empresas por contactar"). Cada paso conserva su
// propia corrida en `background_runs` (historial intacto) y es idempotente:
// re-ejecutar no duplica (scout upsert, strategist límite, copywriter salta
// busySignal/busyCustomer, prospect dedupe por URL). Best-effort: un paso
// que falla no tumba los siguientes ni el login.
import { getSupabase } from "@/lib/supabase";
import { createLogger } from "@/lib/log";
import { formatMoney } from "@/lib/format";

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
  kind: "enrichment" | "scout" | "strategist" | "copywriter" | "prospect" | "brain" | "regenerate" | "backfill",
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

/** Cadena completa de mañana. Llamar dentro de `after()` (no bloquea login). */
export async function runMorningPipeline(storeId: string, opts?: { refreshFoto?: boolean }): Promise<void> {
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
        ticketTxt = brain.ticketP50 != null ? formatMoney(brain.ticketP50, brain.ticketCurrency) : null;
      } catch {
        ticketTxt = null;
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
  // 0b-bis. Backfill de onboarding (una vez por tenant): si nunca hubo
  // foto, reconstruye hoy-90/60/30 y recupera al inbox lo accionable que
  // nunca volvió. Corre antes del gate de cadena-done y antes de la foto
  // de hoy, para que el scout/strategist de esta misma corrida lo procesen.
  // Re-correr es inocuo (fotos idempotentes, recupero omite lo gestionado).
  try {
    const { needsBackfill, runBackfillPhotos, recoverBacklog, BACKFILL_CUTS_DAYS } =
      await import("@/lib/backfill");
    const { finishRun } = await import("@/lib/background");
    const fresh = await needsBackfill(storeId).catch(() => false);
    if (fresh) {
      await step(storeId, "backfill", "Ventana previa", BACKFILL_CUTS_DAYS.length, (runId, sid2) =>
        (async () => {
          const photos = await runBackfillPhotos(sid2);
          const { recovered, skipped } = await recoverBacklog(sid2);
          const detail = photos.map((p) => `${p.cut}:${p.actuar}`).join(",");
          await finishRun(runId, {
            status: "done",
            processed: recovered,
            failed: 0,
            summary: `${recovered} recuperados de ventana previa (omitidos ${skipped}) [${detail}]`,
            pulseState: recovered > 0 ? "needs" : "paused",
          });
          log(`backfill done recovered=${recovered} skipped=${skipped}`);
        })(),
      );
    }
  } catch (e) {
    log(`backfill omitido: ${e instanceof Error ? e.message : e}`);
  }
  // 0b. Auto-refresh stale (#26): corre en CADA login aunque la cadena de
  // hoy ya esté done (como brain/enrichment, antes del gate). Solo
  // pending_review con sello viejo → fresco; approved/dispatched jamás se
  // tocan y nada se auto-envía (HITL intacto). Best-effort con kind
  // `regenerate` (incompatible con copywriter/single en la matriz #16).
  try {
    const { runStaleRefresh } = await import("@/lib/copywriter");
    await step(storeId, "regenerate", "Actualizando borradores", 10, (runId, sid) =>
      runStaleRefresh(runId, sid, { limit: 10 }),
    );
  } catch (e) {
    log(`stale-refresh omitido: ${e instanceof Error ? e.message : e}`);
  }
  // 0c. Foto del día (2026-10-22): si hubo órdenes nuevas o
  // corregidas, la foto vigente miente (t_days congelados) y el scout la
  // reutilizaría igual. Se regenera ANTES del gate de cadena-done (ese gate
  // es justo el que escondía el bug: cadena done + datos nuevos). Upsert
  // sobre las mismas keys del día: idempotente, sin borrar nada. Sin
  // cambios se reutiliza (ahorro intacto). FallaEnAbierto: si el recompute
  // falla, el scout sigue con la foto vigente (conducta anterior).
  if (opts?.refreshFoto) {
    try {
      const { runRetentionModel } = await import("@/lib/retention");
      const r = await runRetentionModel(storeId, new Date());
      log(`foto regenerada: predicted=${r.predicted} actuar=${r.actuar} vigilar=${r.vigilar}`);
    } catch (e) {
      log(`foto no regenerada (${e instanceof Error ? e.message : e}): el scout usa la vigente`);
    }
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
  const { runProspect, countPendingLeads, prospectEligibility } = await import("@/lib/prospect");
  const { PROSPECT_LEAD_CAP, PROSPECT_PAUSED_HINT, PROSPECT_B2B_ONLY_HINT } = await import("@/lib/prospect-cap");
  const { finishRun: finishProspect } = await import("@/lib/background");
  // Sin segmentación: toda la tienda es un solo universo.
  const prospectScope = null;
  const prospectMarketLabel = null;
  await step(storeId, "prospect", "Prospección", 0, (runId, sid) =>
    (async () => {
      // B2B-only: siempre hay empresas que buscar; solo se omite sin base.
      try {
        const elig = await prospectEligibility(sid);
        if (!elig.eligible) {
          await finishProspect(runId, {
            status: "done",
            processed: 0,
            failed: 0,
            summary: PROSPECT_B2B_ONLY_HINT,
            pulseState: "paused",
          });
          log("prospect omitido (sin base)");
          return;
        }
      } catch (e) {
        log(`prospect eligibility omitido: ${e instanceof Error ? e.message : e}`);
      }
      // Tope blando del inbox: el auto se pausa con 10 pendientes para no
      // acumular sin revisar. El manual (chat/botón) sí puede pasar el tope.
      try {
        const pending = await countPendingLeads(sid);
        if (pending >= PROSPECT_LEAD_CAP) {
          await finishProspect(runId, {
            status: "done",
            processed: pending,
            failed: 0,
            summary: PROSPECT_PAUSED_HINT,
            pulseState: "needs",
          });
          log(`prospect omitido (tope ${pending}/${PROSPECT_LEAD_CAP})`);
          return;
        }
      } catch (e) {
        log(`prospect count omitido: ${e instanceof Error ? e.message : e}`);
      }
      await runProspect(runId, sid, { queries: 3, perQuery: 5, scope: prospectScope, marketLabel: prospectMarketLabel });
    })(),
  );
  log("morning done");
}
