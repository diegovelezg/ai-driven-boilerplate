// Queue transaccional en Postgres (issue #24): web encola, worker ejecuta.
// Sin Redis/BullMQ: claim con SELECT ... FOR UPDATE SKIP LOCKED (vía RPC
// `claim_next_job`), retries con backoff exponencial + DLQ (`dead`),
// idempotencia por (store_id, idempotency_key).
//
// Sin `server-only`: el worker tsx lo importa en node; ningún client
// component lo importa (solo service_role escribe; la UI lee `background_runs`).
import { getSupabase } from "@/lib/supabase";

export type JobKind =
  | "sync"
  | "morning"
  | "enrichment"
  | "scout"
  | "strategist"
  | "copywriter"
  | "prospect";

export type JobStatus = "queued" | "running" | "done" | "error" | "dead";

export interface Job {
  id: string;
  storeId: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runId: string | null;
  idempotencyKey: string | null;
  availableAt: string;
  createdAt: string;
}

const KINDS: JobKind[] = ["sync", "morning", "enrichment", "scout", "strategist", "copywriter", "prospect"];

function mapJob(r: Record<string, unknown>): Job {
  const kind = String(r.kind ?? "");
  return {
    id: String(r.id),
    storeId: String(r.store_id),
    kind: (KINDS.includes(kind as JobKind) ? kind : "morning") as JobKind,
    payload: ((r.payload as Record<string, unknown>) ?? {}) as Record<string, unknown>,
    status: (r.status as JobStatus) ?? "queued",
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.max_attempts ?? 3),
    runId: (r.run_id as string | null) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    availableAt: String(r.available_at ?? ""),
    createdAt: String(r.created_at ?? ""),
  };
}

/** Partes de fecha/hora en America/Lima sin depender del formato ICU local
 *  (`toLocaleString` + `new Date()` parsea non-ISO y en ICU mínima da
 *  Invalid Date → `morning-NaN-NaN-NaN` y el dedupe diario se rompe). */
function limaParts(date: Date): { y: string; m: string; d: string; hh: string; mi: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mi: get("minute") };
}

/** Clave idempotente del pipeline diario (1 por store y día Lima). */
export function morningIdempotencyKey(date = new Date()): string {
  const { y, m, d } = limaParts(date);
  return `morning-${y}-${m}-${d}`;
}

/** Throttle de sync por login alineado con `LOGIN_SYNC_MIN_INTERVAL_MS`:
 *  1 key por bucket de 15min (Lima). Logins concurrentes en el mismo bucket
 *  dedupean en el enqueue en vez de duplicar full-downloads. */
export const LOGIN_SYNC_BUCKET_MIN = 15;

export function loginSyncIdempotencyKey(date = new Date()): string {
  const { y, m, d, hh, mi } = limaParts(date);
  const bucket = String(Math.floor(Number(mi) / LOGIN_SYNC_BUCKET_MIN) * LOGIN_SYNC_BUCKET_MIN).padStart(2, "0");
  return `sync-login-${y}-${m}-${d}-${hh}${bucket}`;
}

/** Backoff exponencial entre reintentos: 1min, 2min, 4min… (acotado a 30min). */
export function nextRetryDelayMs(attempts: number): number {
  const base = 60_000 * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(base, 30 * 60_000);
}

export interface EnqueueOpts {
  payload?: Record<string, unknown>;
  /** Dedupe lógico: re-encolar con la misma key es no-op. */
  idempotencyKey?: string | null;
  /** Para programar a futuro (retries usan backoff, no esto). */
  availableAt?: string | null;
  maxAttempts?: number;
}

/**
 * Encola un job (respuesta <200ms, sin trabajo pesado). Con idempotency_key
 * el duplicado es no-op y devuelve la fila existente. Si la tabla aún no
 * existe (DB sin migrar), lanza y el caller hace fallback legacy.
 */
export async function enqueueJob(storeId: string, kind: JobKind, opts: EnqueueOpts = {}): Promise<Job> {
  const db = getSupabase();
  const row = {
    store_id: storeId,
    kind,
    payload: opts.payload ?? {},
    ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
    ...(opts.availableAt ? { available_at: opts.availableAt } : {}),
    ...(opts.maxAttempts ? { max_attempts: opts.maxAttempts } : {}),
  };
  const q = db.from("jobs").insert(row).select("*").single();
  const { data, error } = await q;
  if (!error && data) return mapJob(data as Record<string, unknown>);
  // Dedupe: la key ya existe → devuelve la fila original (no duplica ejecución).
  const msg = error?.message ?? "";
  if (opts.idempotencyKey && /duplicate|conflict|unique/i.test(msg)) {
    const existing = await db
      .from("jobs")
      .select("*")
      .eq("store_id", storeId)
      .eq("idempotency_key", opts.idempotencyKey)
      .maybeSingle();
    if (!existing.error && existing.data) return mapJob(existing.data as Record<string, unknown>);
  }
  throw new Error(`Jobs enqueue: ${msg || "insert failed"}`);
}

/** Atajo del scheduler/diario: 1 `morning` por store y día (Lima). */
export async function enqueueMorningDaily(storeId: string, date = new Date()): Promise<Job> {
  const key = morningIdempotencyKey(date);
  return enqueueJob(storeId, "morning", {
    idempotencyKey: key,
    payload: { date: key.replace("morning-", "") },
  });
}

/** Claim atómico del siguiente job listo (SKIP LOCKED: 2 workers no duplican). */
export async function claimNextJob(kinds?: JobKind[]): Promise<Job | null> {
  const db = getSupabase();
  const { data, error } = await db.rpc("claim_next_job", {
    p_kinds: kinds ?? null,
  });
  if (error) throw new Error(`Jobs claim: ${error.message}`);
  if (!data) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return mapJob(row as Record<string, unknown>);
}

export async function completeJob(jobId: string, runId?: string | null): Promise<void> {
  const db = getSupabase();
  await db
    .from("jobs")
    .update({
      status: "done",
      run_id: runId ?? null,
      updated_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", jobId);
}

export async function failJob(jobId: string, err: string, attempts: number, maxAttempts = 3): Promise<void> {
  const db = getSupabase();
  const exhausted = attempts >= maxAttempts;
  await db
    .from("jobs")
    .update({
      status: exhausted ? "dead" : "error",
      last_error: err.slice(0, 2000),
      updated_at: new Date().toISOString(),
      ...(exhausted
        ? { finished_at: new Date().toISOString() }
        : { available_at: new Date(Date.now() + nextRetryDelayMs(attempts)).toISOString() }),
    })
    .eq("id", jobId);
}

/** Heartbeat del worker durante dispatch largos: un job `sync`+morning con LLM
 *  supera fácil los 30min del reap; sin esto el reap lo re-encola mientras el
 *  original sigue corriendo (doble carga a Medusa + doble costo LLM). */
export async function touchJob(jobId: string): Promise<void> {
  const db = getSupabase();
  await db.from("jobs").update({ updated_at: new Date().toISOString() }).eq("id", jobId).eq("status", "running");
}

/** Re-encola `running` colgados (redeploy a mitad de job): no quedan eternos. */
export async function reapStaleJobs(staleMinutes = 30): Promise<number> {
  const db = getSupabase();
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const { data } = await db
    .from("jobs")
    .select("id,attempts,max_attempts")
    .eq("status", "running")
    .lt("updated_at", cutoff);
  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((r) => r.id);
  if (rows.length === 0) return 0;
  for (const r of rows) {
    const attempts = Number(r.attempts ?? 1);
    const max = Number(r.max_attempts ?? 3);
    await failJob(String(r.id), `Stuck sin heartbeat en ${staleMinutes}min (reap automático)`, attempts, max).catch(
      () => {},
    );
  }
  return rows.length;
}
