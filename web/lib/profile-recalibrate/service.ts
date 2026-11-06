// Vigilante semanal de perfil (#6): orquesta scan barato → set caro (solo
// con drift) → propuesta HITL. Nunca auto-apply: aplicar un delta exige
// decisión explícita del merchant en Settings. Solo server (service_role).
import { getSupabase } from "@/lib/supabase";
import {
  getStoreProfile,
  updateStoreProfileSlot,
  type StoreProfile,
} from "@/lib/store-profiles";
import { tenantStats, type TenantStats } from "@/lib/profiling/analyst";
import { finishRun, startRun } from "@/lib/background";
import { formatNumber } from "@/lib/format";
import {
  checkCadence,
  evaluateDrift,
  isProvisional,
  type DriftTrigger,
} from "./scan";
import {
  applyDeltaToProfile,
  buildDeltas,
  collectRejectedKeys,
  mergeDeltaDecision,
  mergeDeltaRevert,
  resolveProposalStatus,
  type ProfileDelta,
  type ProfileSlot,
} from "./diff";
import { appendRecalibrateLog, type RecalibrationSource } from "./log";

export type { RecalibrationSource } from "./log";

export interface ProfileProposal {
  id: string;
  storeId: string;
  status: "pending_review" | "approved" | "rejected" | "expired";
  trigger: string;
  provisional: boolean;
  deltas: ProfileDelta[];
  createdAt: string;
  expiresAt: string;
  /** Versión optimista: el claim de un delta exige where version=visto. */
  version: number;
}

export interface RecalibrationOutcome {
  status: "skipped" | "no-drift" | "proposal" | "dry-run";
  reason: string;
  triggers: DriftTrigger[];
  proposalId?: string;
  deltas?: ProfileDelta[];
}

interface SnapshotRow {
  takenAt: string;
  stats: TenantStats;
}

function mapProposal(r: Record<string, unknown>): ProfileProposal {
  return {
    id: String(r.id),
    storeId: String(r.store_id),
    status: r.status as ProfileProposal["status"],
    trigger: String(r.trigger ?? ""),
    provisional: Boolean(r.provisional),
    deltas: Array.isArray(r.deltas) ? (r.deltas as ProfileDelta[]) : [],
    createdAt: String(r.created_at ?? ""),
    expiresAt: String(r.expires_at ?? ""),
    version: Number(r.version ?? 1),
  };
}

async function getLastSnapshot(storeId: string): Promise<SnapshotRow | null> {
  const { data, error } = await getSupabase()
    .from("profile_snapshots")
    .select("taken_at,stats_json")
    .eq("store_id", storeId)
    .order("taken_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Snapshots read: ${error.message}`);
  if (!data) return null;
  return {
    takenAt: String(data.taken_at),
    stats: data.stats_json as TenantStats,
  };
}

async function insertSnapshot(
  storeId: string,
  stats: TenantStats,
  profile: StoreProfile,
): Promise<void> {
  const { error } = await getSupabase()
    .from("profile_snapshots")
    .insert({ store_id: storeId, stats_json: stats, profile_json: profile });
  if (error) throw new Error(`Snapshot insert: ${error.message}`);
}

/** Propuesta pendiente vigente. Las vencidas (+30d) se expiran al leer. */
export async function getPendingProposal(
  storeId: string,
): Promise<ProfileProposal | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from("profile_proposals")
    .select("*")
    .eq("store_id", storeId)
    .eq("status", "pending_review")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Proposals read: ${error.message}`);
  if (!data) return null;
  const proposal = mapProposal(data as Record<string, unknown>);
  if (new Date(proposal.expiresAt).getTime() < Date.now()) {
    await db
      .from("profile_proposals")
      .update({ status: "expired" })
      .eq("id", proposal.id);
    return null;
  }
  return proposal;
}

/** Deltas rechazados hace <60d desde su decisión: no se re-proponen. */
async function getRejectedKeys(storeId: string): Promise<Set<string>> {
  const { data, error } = await getSupabase()
    .from("profile_proposals")
    .select("created_at,deltas")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`Proposals read: ${error.message}`);
  const rows = (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      createdAt: String(row.created_at ?? ""),
      deltas: Array.isArray(row.deltas) ? (row.deltas as ProfileDelta[]) : [],
    };
  });
  return collectRejectedKeys(rows, new Date());
}

async function getProfileAgeDays(storeId: string): Promise<number | null> {
  const { data, error } = await getSupabase()
    .from("store_profiles")
    .select("interpreted_at,updated_at")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error || !data) return null;
  const raw = (data.interpreted_at as string) ?? (data.updated_at as string);
  if (!raw) return null;
  return (Date.now() - new Date(raw).getTime()) / 86_400_000;
}

const DAY_MS = 86_400_000;

/**
 * Una pasada del vigilante. Barata si no toca (cadencia) o si no hay drift
 * (solo snapshot); cara (set perfilador) únicamente con trigger fuerte.
 * Deja UNA línea en .data/recalibrate.jsonl siempre (incluso skipped/error).
 */
export async function runRecalibration(
  storeId: string,
  opts: { source: RecalibrationSource; dryRun?: boolean },
): Promise<RecalibrationOutcome> {
  const t0 = Date.now();
  const dryRun = opts.dryRun === true;
  try {
    const outcome = await runRecalibrationInner(storeId, opts);
    appendRecalibrateLog({
      store_id: storeId,
      source: opts.source,
      dry_run: dryRun,
      outcome: outcome.status,
      reason: outcome.reason,
      triggers: outcome.triggers.map((t) => ({
        kind: t.kind,
        detail: t.detail,
        requiresProfiler: t.requiresProfiler,
      })),
      proposal_id: outcome.proposalId,
      deltas: outcome.deltas?.map((d) => ({ slot: d.slot, de: d.de, a: d.a })),
      duration_ms: Date.now() - t0,
    });
    return outcome;
  } catch (e) {
    const reason = e instanceof Error ? e.message : "error";
    appendRecalibrateLog({
      store_id: storeId,
      source: opts.source,
      dry_run: dryRun,
      outcome: "error",
      reason,
      triggers: [],
      duration_ms: Date.now() - t0,
    });
    throw e;
  }
}

async function runRecalibrationInner(
  storeId: string,
  opts: { source: RecalibrationSource; dryRun?: boolean },
): Promise<RecalibrationOutcome> {
  const manual = opts.source === "manual";
  const profile = await getStoreProfile(storeId);
  if (!profile) return { status: "skipped", reason: "Sin perfil de tenant.", triggers: [] };

  if (await getPendingProposal(storeId)) {
    return {
      status: "skipped",
      reason: "Ya hay una propuesta de perfil esperando revisión.",
      triggers: [],
    };
  }

  const last = await getLastSnapshot(storeId);
  // Pre-check barato: sin stats todavía, la cadencia de 7d ya puede cerrar.
  if (
    last &&
    !manual &&
    Date.now() - new Date(last.takenAt).getTime() < 7 * DAY_MS
  ) {
    return {
      status: "skipped",
      reason: "Última revisión hace menos de 7 días.",
      triggers: [],
    };
  }

  const stats = await tenantStats(storeId);
  const newBuyers = last ? stats.buyers - last.stats.buyers : stats.buyers;
  const cadence = checkCadence({
    lastSnapshotAt: last?.takenAt ?? null,
    hasPendingProposal: false,
    newBuyers,
    now: new Date(),
    manual,
  });
  if (!cadence.run) {
    return { status: "skipped", reason: cadence.reason, triggers: [] };
  }

  // Autocalibración del corte de "seguimiento cercano" (display-only, sin
  // HITL): aprende p vs retorno de la historia y escribe
  // `store_profiles.close_watch_p`. Con poca historia conserva el default.
  // Import dinámico: la cadena pesada (orders+predictions) no entra al path
  // barato de cadencia.
  const { createLogger } = await import("@/lib/log");
  const calibLog = createLogger("recalibrate");
  const { calibrateCloseWatchP } = await import("@/lib/close-watch-calibrate");
  const calib = await calibrateCloseWatchP(storeId, { dryRun: opts.dryRun }).catch((e) => ({
    fitted: null as number | null,
    previous: 0.1,
    samples: 0,
    positives: 0,
    wrote: false,
    reason: `Calibración omitida: ${e instanceof Error ? e.message : "error"}.`,
  }));
  calibLog(`close_watch_p: ${calib.reason}`);

  // Autocalibración de bandas (multitenant, 30d, con consecuencias en
  // decisión): aprende high/low de p vs retorno y escribe
  // `store_profiles.p_band_*` con trust region. Throttle propio de 30d por
  // tenant (vive en Postgres, no en archivos). Con poca historia conserva.
  const { calibrateBandCuts } = await import("@/lib/band-calibrate");
  const bandCalib = await calibrateBandCuts(storeId, { dryRun: opts.dryRun }).catch((e) => ({
    fittedHigh: null as number | null,
    fittedLow: null as number | null,
    previousHigh: 0.6,
    previousLow: 0.15,
    samples: 0,
    positives: 0,
    wrote: false,
    reason: `Calibración omitida: ${e instanceof Error ? e.message : "error"}.`,
  }));
  calibLog(`band_cuts: ${bandCalib.reason}`);

  // Tune mensual del modelo (issue #27 Paso 4): re-aprende ventana de
  // episodio + mezcla K con backtest contra la versión vigente. Solo escribe
  // si la candidata gana por margen; lo estructural (cambio de K) se propone
  // sin auto-aplicar. Fail-open como bandas (nunca rompe el recalibrado).
  const { tuneModelParams } = await import("@/lib/model-tune");
  const modelTune = await tuneModelParams(storeId, { dryRun: opts.dryRun }).catch((e) => ({
    wrote: false,
    action: "keep" as const,
    partitions: [],
    reason: `Tune omitido: ${e instanceof Error ? e.message : "error"}.`,
  }));
  calibLog(`model_tune: ${modelTune.reason}`);

  const ageDays = await getProfileAgeDays(storeId);
  const triggers = evaluateDrift(
    last?.stats ?? null,
    stats,
    { archetypeSource: profile.archetypeSource, ageDays },
    { manual },
  );
  const strong = triggers.filter((t) => t.requiresProfiler);

  if (opts.dryRun) {
    return {
      status: "dry-run",
      reason:
        strong.length > 0
          ? `Dry-run: ${formatNumber(strong.length)} trigger(s) llamarían al set perfilador. ${calib.reason} ${modelTune.reason}`
          : `Dry-run: sin drift, no se llamaría al set perfilador. ${calib.reason} ${modelTune.reason}`,
      triggers,
    };
  }

  // Sin descripción el set no puede proponer: se informa SIN avanzar cadencia
  // (sin snapshot), para no silenciar el drift 7 días sin haberlo examinado.
  const description = profile.description ?? profile.verticalDetected ?? "";
  if (strong.length > 0 && !description.trim()) {
    return {
      status: "no-drift",
      reason: "Hay drift pero sin descripción del negocio el set no puede proponer.",
      triggers,
    };
  }

  if (strong.length === 0) {
    await insertSnapshot(storeId, stats, profile);
    return {
      status: "no-drift",
      reason:
        triggers.length > 0
          ? `Sin drift accionable (${triggers.map((t) => t.detail).join(" ")}). ${modelTune.reason}`
          : `Sin drift: el perfil sigue representando a la tienda. ${modelTune.reason}`,
      triggers,
    };
  }

  // Set caro: import dinámico para no arrastrar la cadena del perfilador
  // (verticals → prospect → lib/log con "server-only") en el path barato.
  // Los scripts tsx (dry-run, cadencia, sin drift) nunca lo cargan.
  const { runProfiler } = await import("@/lib/profiling/pipeline");
  const { synthesis } = await runProfiler(storeId, description);
  const deltas = buildDeltas(
    profile,
    {
      archetype: synthesis.archetype,
      cycleDays: synthesis.cycleDays,
      taxonomyId: synthesis.taxonomyId,
      buyerType: synthesis.buyerType,
      evidence: synthesis.evidence,
    },
    {
      intervalCoverage: stats.intervalCoverage,
      intervalMedian: stats.intervalMedian,
      rejectedKeys: await getRejectedKeys(storeId),
    },
  );
  if (deltas.length === 0) {
    await insertSnapshot(storeId, stats, profile);
    return {
      status: "no-drift",
      reason: "El set revisó el perfil y no propuso cambios (o ya fueron rechazados).",
      triggers,
    };
  }

  const { data, error } = await getSupabase()
    .from("profile_proposals")
    .insert({
      store_id: storeId,
      status: "pending_review",
      trigger: [...new Set(strong.map((t) => t.kind))].join(","),
      provisional: isProvisional(strong, stats.buyers),
      deltas,
    })
    .select("*")
    .single();
  if (error) {
    // Carrera contra el índice único de 1 pendiente: silencio, no error.
    if (error.code === "23505") {
      return {
        status: "skipped",
        reason: "Ya hay una propuesta de perfil esperando revisión.",
        triggers,
      };
    }
    throw new Error(`Proposal insert: ${error.message}`);
  }
  // Snapshot DESPUÉS de crear la propuesta: si el insert de arriba falla,
  // la cadencia no avanza y el drift vuelve a intentarse en la próxima
  // pasada (mismo criterio que ante un fallo del set caro).
  await insertSnapshot(storeId, stats, profile);
  const proposal = mapProposal(data as Record<string, unknown>);
  return {
    status: "proposal",
    reason: `Propuesta creada con ${formatNumber(deltas.length)} delta(s) para revisar en Settings.`,
    triggers,
    proposalId: proposal.id,
    deltas,
  };
}

export type DecideResult =
  | { ok: true; proposal: ProfileProposal }
  | { ok: false; message: string };

/** Aceptar = aplicar solo ese slot + snapshot post. Rechazar = no re-proponer en 60d.
 *  Cada decisión (y cada fallo) deja línea en .data/recalibrate.jsonl. */
export async function decideDelta(
  storeId: string,
  proposalId: string,
  slot: ProfileSlot,
  accept: boolean,
): Promise<DecideResult> {
  const t0 = Date.now();
  const result = await decideDeltaInner(storeId, proposalId, slot, accept);
  if (result.ok) {
    const d = result.proposal.deltas.find((x) => x.slot === slot);
    appendRecalibrateLog({
      store_id: storeId,
      source: "manual",
      dry_run: false,
      outcome: accept ? "delta-accepted" : "delta-rejected",
      reason: accept
        ? `Delta ${slot} aplicado al perfil (propuesta ${result.proposal.status}).`
        : `Delta ${slot} descartado (no se re-propone en 60d).`,
      triggers: [],
      proposal_id: result.proposal.id,
      deltas: d ? [{ slot: d.slot, de: d.de, a: d.a }] : [],
      duration_ms: Date.now() - t0,
    });
  } else {
    appendRecalibrateLog({
      store_id: storeId,
      source: "manual",
      dry_run: false,
      outcome: "delta-error",
      reason: result.message,
      triggers: [],
      proposal_id: proposalId,
      duration_ms: Date.now() - t0,
    });
  }
  return result;
}

async function decideDeltaInner(
  storeId: string,
  proposalId: string,
  slot: ProfileSlot,
  accept: boolean,
  attempt = 0,
): Promise<DecideResult> {
  const db = getSupabase();
  const proposal = await getPendingProposal(storeId);
  if (!proposal || proposal.id !== proposalId) {
    return { ok: false, message: "La propuesta ya no está pendiente." };
  }
  const delta = proposal.deltas.find(
    (d) => d.slot === slot && d.decision === "pending",
  );
  if (!delta) return { ok: false, message: "Ese cambio ya fue decidido." };

  // Validar ANTES de reclamar: un delta inválido no debe marcar nada.
  if (accept) {
    const profile = await getStoreProfile(storeId);
    if (!profile) return { ok: false, message: "Sin perfil de tenant." };
    const applied = applyDeltaToProfile(profile, delta);
    if (!applied.ok) return { ok: false, message: applied.message };
  }

  // Claim versionado: fusiono mi decisión sobre lo fresco y reclamo con
  // where version=visto. 0 filas = otro decidió en paralelo → re-leo una vez.
  const merged = mergeDeltaDecision(
    proposal.deltas,
    slot,
    accept ? "accepted" : "rejected",
    new Date().toISOString(),
  );
  if (!merged) return { ok: false, message: "Ese cambio ya fue decidido." };
  const status = resolveProposalStatus(merged);
  const { data, error } = await db
    .from("profile_proposals")
    .update({
      deltas: merged,
      status,
      decided_at: status !== "pending_review" ? new Date().toISOString() : null,
      version: proposal.version + 1,
    })
    .eq("id", proposal.id)
    .eq("version", proposal.version)
    .select("*")
    .single();
  if (error) {
    // PGRST116 = el update no tocó filas: carrera perdida. Re-leo una vez;
    // si mi slot sigue pending reintento, si no informo sin pisar.
    if (error.code === "PGRST116" && attempt < 1) {
      const fresh = await getPendingProposal(storeId).catch(() => null);
      if (
        fresh &&
        fresh.id === proposalId &&
        fresh.deltas.some((d) => d.slot === slot && d.decision === "pending")
      ) {
        return decideDeltaInner(storeId, proposalId, slot, accept, attempt + 1);
      }
      return { ok: false, message: "Ese cambio ya fue decidido." };
    }
    return { ok: false, message: `No pude guardar la decisión: ${error.message}` };
  }

  // Claim ganado: recién ahora aplico, y SOLO la columna de este slot
  // sobre una lectura fresca. Aceptaciones paralelas de slots distintos
  // no se pisan (nada de upsert del perfil completo).
  if (accept) {
    const fail = async (message: string): Promise<DecideResult> => {
      const reverted = await revertDeltaClaim(proposal.id, slot);
      return {
        ok: false,
        message: reverted
          ? `${message} El cambio quedó pendiente de nuevo: puedes reintentarlo.`
          : `${message} Tu decisión quedó guardada pero el cambio no se aplicó: revísalo en Settings.`,
      };
    };
    const fresh = await getStoreProfile(storeId).catch(() => null);
    if (!fresh) return fail("Sin perfil de tenant.");
    const applied = applyDeltaToProfile(fresh, delta);
    if (!applied.ok) return fail(applied.message);
    try {
      await updateStoreProfileSlot(storeId, slot, delta.a);
    } catch (e) {
      return fail(
        `No pude aplicar el cambio al perfil: ${e instanceof Error ? e.message : "error"}.`,
      );
    }
    // Snapshot post-aceptación: la próxima comparación parte de lo aplicado.
    const stats = await tenantStats(storeId).catch(() => null);
    if (stats) await insertSnapshot(storeId, stats, applied.profile).catch(() => undefined);
  }
  return { ok: true, proposal: mapProposal(data as Record<string, unknown>) };
}

/**
 * Deshace el claim de una decisión cuya aplicación al perfil falló:
 * revierte SOLO ese slot sobre el estado fresco, preservando decisiones
 * posteriores de otros slots aunque hayan avanzado la versión (o cerrado
 * la propuesta). CAS sobre la versión vigente, con reintentos: el delta
 * vuelve a `pending` y se puede reintentar, no queda "accepted" fantasma.
 */
async function revertDeltaClaim(proposalId: string, slot: ProfileSlot): Promise<boolean> {
  const db = getSupabase();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: row, error: readError } = await db
      .from("profile_proposals")
      .select("*")
      .eq("id", proposalId)
      .maybeSingle();
    if (readError || !row) return false;
    const fresh = mapProposal(row as Record<string, unknown>);
    const current = fresh.deltas.find((d) => d.slot === slot);
    if (!current) return false;
    if (current.decision === "pending") return true;
    const merged = mergeDeltaRevert(fresh.deltas, slot);
    if (!merged) return false;
    const status = resolveProposalStatus(merged);
    const { data, error } = await db
      .from("profile_proposals")
      .update({
        deltas: merged,
        status,
        decided_at: status !== "pending_review" ? new Date().toISOString() : null,
        version: fresh.version + 1,
      })
      .eq("id", fresh.id)
      .eq("version", fresh.version)
      .select("id");
    if (!error && data && data.length > 0) return true;
    if (error) return false;
    // 0 filas: otra decisión avanzó la versión entre leer y escribir.
    // Se re-lee el estado fresco y se reintenta sobre la nueva versión.
  }
  return false;
}

/** Corre el vigilante registrando la corrida en la cinta (background_runs). */
export async function recalibrateWithRun(
  storeId: string,
  source: RecalibrationSource,
): Promise<RecalibrationOutcome> {
  // Sin cinta si no toca: el post-import no debe ensuciar el progreso global.
  // Pero el silencio sí queda en .data/recalibrate.jsonl (auditable).
  if (source !== "manual") {
    const [pending, last] = await Promise.all([
      getPendingProposal(storeId).catch(() => null),
      getLastSnapshot(storeId).catch(() => null),
    ]);
    if (pending) {
      const outcome: RecalibrationOutcome = { status: "skipped", reason: "Propuesta pendiente.", triggers: [] };
      appendRecalibrateLog({
        store_id: storeId,
        source,
        dry_run: false,
        outcome: "skipped",
        reason: outcome.reason,
        triggers: [],
      });
      return outcome;
    }
    if (last && Date.now() - new Date(last.takenAt).getTime() < 7 * DAY_MS) {
      const outcome: RecalibrationOutcome = { status: "skipped", reason: "Revisión reciente (<7d).", triggers: [] };
      appendRecalibrateLog({
        store_id: storeId,
        source,
        dry_run: false,
        outcome: "skipped",
        reason: outcome.reason,
        triggers: [],
      });
      return outcome;
    }
  }
  const runId = await startRun(storeId, "recalibrate", "Revisión de perfil", 1);
  try {
    const outcome = await runRecalibration(storeId, { source });
    await finishRun(runId, {
      status: "done",
      processed: 1,
      failed: 0,
      summary: outcome.reason,
    });
    return outcome;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    await finishRun(runId, {
      status: "error",
      processed: 0,
      failed: 1,
      error: msg,
    }).catch(() => undefined);
    const outcome: RecalibrationOutcome = { status: "skipped", reason: `Revisión de perfil falló: ${msg}`, triggers: [] };
    appendRecalibrateLog({
      store_id: storeId,
      source,
      dry_run: false,
      outcome: "skipped",
      reason: outcome.reason,
      triggers: [],
    });
    return outcome;
  }
}
