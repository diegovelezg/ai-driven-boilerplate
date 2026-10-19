// Corridas en segundo plano. Fuente única de verdad (SSOT) para la cinta de
// progreso global: cualquier trabajo de larga duración (enriquecimiento, sync,
// ...) registra aquí su estado y la UI lo muestra con un solo componente.
// Sin `server-only`: los scripts tsx (enrich-once, prospect-once) lo importan;
// ningún componente cliente lo importa en runtime (solo el tipo BackgroundRun).
//
// Contrato de `summary` (filosofía TeamPulse): 1 línea, lenguaje humano,
// outcome + $ cuando aplique, pausa intencional explicada. Nunca jerga de logs
// ("revisados/nuevas/actualizadas", "medidas", "fallidos", "[STUB]", emails).
// Formatos por agente:
// - scout: "Vigiló N · X listos para actuar" | "Vigiló N, nadie necesita mensaje · no quemamos descuentos"
// - strategist: "X ordenados, empieza por {nombre}" | "Sin ordenar, nada urgente"
// - copywriter: "X listos para tu visto bueno" | "Sin borradores nuevos, X ya tenían borrador · no duplico" | "Sin borradores, no había priorizados frescos"
// - prospect: "X parecidos a tu ideal por revisar" | "En pausa, primero recuperamos lo tuyo"
// - dispatcher: "X listos, conecta WhatsApp/email para enviar" | "X enviadas, solo lo aprobado"
// - analyst: "X volvieron · {monto} recuperado" | "Observando X enviados, mide en N días"
// El `failed` va en su columna, no en el texto. `current` nunca lleva PII (emails).
import { getSupabase } from "@/lib/supabase";
import {
  conflictMessage,
  findConflict,
  type ActiveOp,
  type ErrorCode,
  type ScopeKind,
} from "@/lib/operations";

export type RunStatus = "running" | "done" | "error";

/** Estado TeamPulse que cada corrida declara al cerrar: la SSOT para ordenar
 *  needs > active > paused. `null` = corrida vieja (pre-migración). */
export type PulseState = "needs" | "active" | "paused";

export interface BackgroundRun {
  id: string;
  kind: string;
  label: string;
  status: RunStatus;
  pulseState: PulseState | null;
  total: number;
  processed: number;
  failed: number;
  current: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Acotación del lock (issue #16 Fase 0): `global` = toda la tienda,
   *  `signal`/`customer`/`domain` + `scopeId` = una sola unidad. */
  scopeKind: ScopeKind;
  scopeId: string | null;
  /** Heartbeat de los workers (último `advanceRun`/`touchRun`). */
  updatedAt: string | null;
  /** Cierre tipado para la UI (veto ≠ fallo). */
  errorCode: ErrorCode | null;
}

const SCOPE_KINDS: ScopeKind[] = ["global", "signal", "customer", "domain"];
const ERROR_CODES: ErrorCode[] = ["judge_veto", "busy", "llm_fail", "stale", "conflict"];

function mapRun(r: Record<string, unknown>): BackgroundRun {
  const scopeKind = r.scope_kind as ScopeKind | null;
  const errorCode = r.error_code as ErrorCode | null;
  return {
    id: String(r.id),
    kind: (r.kind as string) ?? "",
    label: (r.label as string) ?? "",
    status: (r.status as RunStatus) ?? "running",
    pulseState: ((r.pulse_state as PulseState | null) ?? null),
    total: Number(r.total ?? 0),
    processed: Number(r.processed ?? 0),
    failed: Number(r.failed ?? 0),
    current: (r.current as string) ?? null,
    summary: (r.summary as string) ?? null,
    error: (r.error as string) ?? null,
    startedAt: String(r.started_at ?? ""),
    finishedAt: (r.finished_at as string) ?? null,
    scopeKind: (scopeKind && SCOPE_KINDS.includes(scopeKind) ? scopeKind : "global"),
    scopeId: (r.scope_id as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
    errorCode: (errorCode && ERROR_CODES.includes(errorCode) ? errorCode : null),
  };
}

export async function getLatestRun(storeId: string): Promise<BackgroundRun | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from("background_runs")
    .select("*")
    .eq("store_id", storeId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Runs read: ${error.message}`);
  return data ? mapRun(data as Record<string, unknown>) : null;
}

/** ISO del último run terminado de un kind (para throttles). null si nunca. */
export async function getLastFinishedAt(storeId: string, kind: string): Promise<string | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from("background_runs")
    .select("started_at,finished_at")
    .eq("store_id", storeId)
    .eq("kind", kind)
    .neq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  const r = (data ?? null) as Record<string, unknown> | null;
  if (!r) return null;
  return (String(r.finished_at ?? r.started_at ?? "") || null) as string | null;
}

export async function hasRunningRun(
  storeId: string,
  filter?: { kinds?: string[]; scopeKind?: ScopeKind; scopeId?: string | null },
): Promise<boolean> {
  // Sin filtro: vía rápida legacy (1 fila, sin leer el universo).
  if (!filter) {
    const db = getSupabase();
    const { data, error } = await db
      .from("background_runs")
      .select("id")
      .eq("store_id", storeId)
      .eq("status", "running")
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Runs read: ${error.message}`);
    return Boolean(data);
  }
  const running = await getRunningRuns(storeId);
  return running.some(
    (r) =>
      (!filter.kinds || filter.kinds.includes(r.kind)) &&
      (!filter.scopeKind || r.scopeKind === filter.scopeKind) &&
      (filter.scopeId === undefined || r.scopeId === filter.scopeId),
  );
}

/** Todas las corridas en curso (el lock granular y la cinta las leen de aquí). */
async function getRunningRuns(storeId: string): Promise<BackgroundRun[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("background_runs")
    .select("*")
    .eq("store_id", storeId)
    .eq("status", "running")
    .order("started_at", { ascending: false });
  if (error) throw new Error(`Runs read: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapRun);
}

/** Fuente de la cinta multi-run (Fase 2): en curso + últimos terminados. */
export async function getActiveRuns(storeId: string, finishedLimit = 3): Promise<BackgroundRun[]> {
  const running = await getRunningRuns(storeId);
  const db = getSupabase();
  const { data, error } = await db
    .from("background_runs")
    .select("*")
    .eq("store_id", storeId)
    .neq("status", "running")
    .order("started_at", { ascending: false })
    .limit(finishedLimit);
  if (error) throw new Error(`Runs read: ${error.message}`);
  const finished = ((data ?? []) as Array<Record<string, unknown>>).map(mapRun);
  return [...running, ...finished];
}

function toActiveOp(r: BackgroundRun): ActiveOp {
  return { kind: r.kind, scopeKind: r.scopeKind, scopeId: r.scopeId, label: r.label };
}

/** Primitiva del lock por compatibilidad (Fase 3): la corrida en curso
 *  incompatible con `{kind, scope}`, o `null` si hay vía libre. */
export async function hasConflict(
  storeId: string,
  op: { kind: string; scopeKind?: ScopeKind; scopeId?: string | null },
): Promise<BackgroundRun | null> {
  const running = await getRunningRuns(storeId);
  const hit = findConflict(op, running.map(toActiveOp));
  if (!hit) return null;
  return running.find((r) => r.kind === hit.kind && r.scopeId === hit.scopeId && r.label === hit.label) ?? null;
}

/** Mensaje de rechazo por lock (`En curso: Copywriter…`). */
export function busyMessage(conflict: BackgroundRun): string {
  return conflictMessage(toActiveOp(conflict));
}

/** Minutos sin heartbeat tras los cuales un `running` se da por muerto.
 *  `advanceRun` toca `updated_at` en cada paso, así que una corrida que
 *  progresa nunca se siega; una colgada (crash, deploy, script manual)
 *  libera el lock sola en vez de bloquear para siempre. */
const STALE_RUN_MINUTES = 30;

/** Marca como error los `running` sin heartbeat (best-effort, nunca lanza).
 *  Devuelve cuántos segó. */
async function reapStaleRuns(storeId: string): Promise<number> {
  try {
    const db = getSupabase();
    const cutoff = Date.now() - STALE_RUN_MINUTES * 60_000;
    const { data, error } = await db
      .from("background_runs")
      .select("id,started_at,updated_at")
      .eq("store_id", storeId)
      .eq("status", "running");
    if (error || !data) return 0;
    const dead = ((data ?? []) as Array<Record<string, unknown>>)
      .filter((r) => {
        const beat = String(r.updated_at ?? r.started_at ?? "");
        const t = beat ? Date.parse(beat) : NaN;
        return Number.isNaN(t) || t < cutoff;
      })
      .map((r) => String(r.id ?? ""))
      .filter(Boolean);
    if (dead.length === 0) return 0;
    await db
      .from("background_runs")
      .update({
        status: "error",
        error: `Stuck sin cierre ni heartbeat en ${STALE_RUN_MINUTES}min (reap automático)`,
        current: null,
        finished_at: new Date().toISOString(),
      })
      .in("id", dead);
    return dead.length;
  } catch {
    return 0;
  }
}

export async function startRun(
  storeId: string,
  kind: string,
  label: string,
  total: number,
  opts?: { scopeKind?: ScopeKind; scopeId?: string | null },
): Promise<string> {
  // Auto-limpieza: un colgado no debe bloquear a los vivos.
  await reapStaleRuns(storeId).catch(() => {});
  const db = getSupabase();
  const scopeKind = opts?.scopeKind ?? "global";
  const scopeId = opts?.scopeId ?? null;
  // Migración 20261021000000: si la DB aún no la tiene, reintenta legacy.
  const { data, error } = await db
    .from("background_runs")
    .insert({ store_id: storeId, kind, label, total, status: "running", scope_kind: scopeKind, scope_id: scopeId })
    .select("id")
    .single();
  if (!error && data) return String(data.id);
  const legacy = await db
    .from("background_runs")
    .insert({ store_id: storeId, kind, label, total, status: "running" })
    .select("id")
    .single();
  if (legacy.error || !legacy.data) throw new Error(`Run insert: ${legacy.error?.message ?? error?.message}`);
  return String(legacy.data.id);
}

/** Actualiza el total de una corrida en curso (para progreso honesto 0/0 → N). */
export async function setRunTotal(runId: string, total: number): Promise<void> {
  const db = getSupabase();
  await db.from("background_runs").update({ total }).eq("id", runId);
}

/** Actualiza el progreso en vivo de una corrida (con heartbeat). En DBs
 *  sin `updated_at` reintenta sin él: el progreso nunca se pierde. */
export async function advanceRun(
  runId: string,
  p: { processed: number; failed: number; current: string | null },
): Promise<void> {
  const db = getSupabase();
  const now = new Date().toISOString();
  const { error } = await db
    .from("background_runs")
    .update({ current: p.current, processed: p.processed, failed: p.failed, updated_at: now })
    .eq("id", runId);
  if (!error) return;
  await db
    .from("background_runs")
    .update({ current: p.current, processed: p.processed, failed: p.failed })
    .eq("id", runId);
}

/** Cierra una corrida con su resultado final. */
export async function finishRun(
  runId: string,
  p: {
    status: RunStatus;
    processed: number;
    failed: number;
    summary?: string | null;
    error?: string | null;
    pulseState?: PulseState | null;
    errorCode?: ErrorCode | null;
  },
): Promise<void> {
  const db = getSupabase();
  const base = {
    status: p.status,
    processed: p.processed,
    failed: p.failed,
    summary: p.summary ?? null,
    error: p.error ?? null,
    current: null,
    finished_at: new Date().toISOString(),
  };
  if (p.pulseState || p.errorCode) {
    // Migraciones 20261019000000/20261021000000: si la DB aún no las
    // tiene, reintenta sin ellas.
    const { error } = await db
      .from("background_runs")
      .update({
        ...base,
        ...(p.pulseState ? { pulse_state: p.pulseState } : null),
        ...(p.errorCode ? { error_code: p.errorCode } : null),
      })
      .eq("id", runId);
    if (!error) return;
  }
  await db.from("background_runs").update(base).eq("id", runId);
}
