// Log auditable del vigilante de perfil (#6): JSONL en .data/recalibrate.jsonl.
// "Siempre": cada pasada (script, post-sync, manual) deja una línea, incluso
// los silencios (skipped) y los errores; cada decisión por delta también.
// El silencio por defecto debe ser auditable: si no propuso nada, el log dice por qué.
// Escritura sincrónica best-effort (las corridas son semanales): nunca rompe
// la corrida si el disco falla. Sin "server-only": lo usan scripts tsx y server.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const RECALIBRATE_LOG = join(process.cwd(), ".data", "recalibrate.jsonl");

export type RecalibrationSource = "post-sync" | "manual" | "script";

export type RecalibrateOutcomeKind =
  | "skipped"
  | "no-drift"
  | "proposal"
  | "dry-run"
  | "error"
  | "delta-accepted"
  | "delta-rejected"
  | "delta-error";

export interface RecalibrateTriggerInfo {
  kind: string;
  detail: string;
  requiresProfiler: boolean;
}

export interface RecalibrateDeltaInfo {
  slot: string;
  de: string | null;
  a: string | null;
}

export interface RecalibrateLogEvent {
  ts: string;
  store_id: string;
  source: RecalibrationSource;
  dry_run: boolean;
  outcome: RecalibrateOutcomeKind;
  reason: string;
  triggers: RecalibrateTriggerInfo[];
  proposal_id?: string;
  deltas?: RecalibrateDeltaInfo[];
  duration_ms?: number;
}

export type RecalibrateLogInput = Omit<RecalibrateLogEvent, "ts"> & { ts?: string };

/** Serializa un evento a una línea JSONL (puro, testeable). */
export function formatRecalibrateLine(e: RecalibrateLogInput): string {
  return JSON.stringify({ ts: new Date().toISOString(), ...e });
}

/** Parsea una línea del log; null si está corrupta (el lector la cuenta y sigue). */
export function parseRecalibrateLine(line: string): RecalibrateLogEvent | null {
  try {
    const p = JSON.parse(line) as Record<string, unknown>;
    if (!p || typeof p.ts !== "string" || typeof p.outcome !== "string") return null;
    return {
      ts: p.ts,
      store_id: typeof p.store_id === "string" ? p.store_id : "",
      source: p.source as RecalibrateLogEvent["source"],
      dry_run: p.dry_run === true,
      outcome: p.outcome as RecalibrateLogEvent["outcome"],
      reason: typeof p.reason === "string" ? p.reason : "",
      triggers: Array.isArray(p.triggers) ? (p.triggers as RecalibrateTriggerInfo[]) : [],
      proposal_id: typeof p.proposal_id === "string" ? p.proposal_id : undefined,
      deltas: Array.isArray(p.deltas) ? (p.deltas as RecalibrateDeltaInfo[]) : undefined,
      duration_ms: typeof p.duration_ms === "number" ? p.duration_ms : undefined,
    };
  } catch {
    return null;
  }
}

/** Agrega un evento al log. Nunca lanza. `file` solo existe para tests. */
export function appendRecalibrateLog(e: RecalibrateLogInput, file?: string): void {
  try {
    const target = file ?? RECALIBRATE_LOG;
    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(target, formatRecalibrateLine(e) + "\n", "utf-8");
  } catch (err) {
    console.warn(
      `[recalibrate] no pude escribir el log: ${err instanceof Error ? err.message : err}`,
    );
  }
}
