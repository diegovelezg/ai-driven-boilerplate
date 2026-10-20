// Args del worker cron (sin cola). Módulo puro (sin I/O ni imports
// server): testeable con node:test vía tsx.
// Formas aceptadas: `--once`, `--kinds=sync,morning` o `--kinds sync,morning`,
// `--store=<uuid>` o `--store <uuid>` (una tienda; sin él: todas las medusa).
export interface WorkerArgs {
  once: boolean;
  pollMs: number;
  /** Solo kinds conocidos; `undefined` = no se pasó `--kinds` (todos).
   *  `[]` = se pasó pero ninguno válido (el worker debe fallar, no idle). */
  kinds: string[] | undefined;
  /** Values de `--kinds` que no son kinds conocidos (se ignoran con aviso). */
  unknownKinds: string[];
  /** Tienda única (`undefined` = todas). */
  store: string | undefined;
}

/** Kinds que el worker sabe ejecutar (etapas del pipeline por tienda). */
export const KNOWN_JOB_KINDS: readonly string[] = ["sync", "morning"];

function splitKinds(raw: string): { kinds: string[]; unknownKinds: string[] } {
  const kinds: string[] = [];
  const unknownKinds: string[] = [];
  for (const s of raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)) {
    if (KNOWN_JOB_KINDS.includes(s)) kinds.push(s);
    else unknownKinds.push(s);
  }
  return { kinds, unknownKinds };
}

export function parseWorkerArgs(argv: string[], envPollMs?: string | undefined): WorkerArgs {
  let once = false;
  let pollMs = Number(envPollMs ?? 5000);
  let kinds: string[] | undefined = undefined;
  let unknownKinds: string[] = [];
  let store: string | undefined = undefined;
  const takeKinds = (raw: string): void => {
    const { kinds: ok, unknownKinds: bad } = splitKinds(raw);
    if (ok.length > 0 || bad.length > 0) {
      kinds = ok;
      unknownKinds = [...unknownKinds, ...bad];
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") {
      once = true;
    } else if (a.startsWith("--poll-ms=")) {
      pollMs = Number(a.split("=")[1]) || pollMs;
    } else if (a === "--poll-ms") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        pollMs = Number(next) || pollMs;
        i += 1;
      }
    } else if (a.startsWith("--kinds=")) {
      takeKinds(a.split("=")[1] ?? "");
    } else if (a === "--kinds") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        takeKinds(next);
        i += 1;
      }
    } else if (a.startsWith("--store=")) {
      store = a.split("=")[1]?.trim() || undefined;
    } else if (a === "--store") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        store = next.trim() || undefined;
        i += 1;
      }
    }
  }
  if (!Number.isFinite(pollMs) || pollMs < 500) pollMs = 5000;
  return { once, pollMs, kinds, unknownKinds, store };
}

// Scheduler interno (daemon) vía env: evita el cron externo de Coolify.
// Lima = UTC-5 fijo (Perú sin DST): las 06:00 Lima son las 11:00 UTC.
export const LIMA_OFFSET_MS = -5 * 3_600_000;
export const WORKER_SCHEDULE_DEFAULT_HOUR = 6;
export const WORKER_SCHEDULE_DEFAULT_MINUTE = 0;

export interface WorkerSchedule {
  enabled: boolean;
  hour: number;
  minute: number;
}

function parseHour(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) return fallback;
  return n;
}

function parseMinute(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 59) return fallback;
  return n;
}

export function parseWorkerSchedule(env: {
  WORKER_SCHEDULE?: string | undefined;
  WORKER_CRON_HOUR?: string | undefined;
  WORKER_CRON_MINUTE?: string | undefined;
  [key: string]: string | undefined;
}): WorkerSchedule {
  const v = (env.WORKER_SCHEDULE ?? "").trim().toLowerCase();
  return {
    enabled: v === "1" || v === "true" || v === "on" || v === "yes",
    hour: parseHour(env.WORKER_CRON_HOUR, WORKER_SCHEDULE_DEFAULT_HOUR),
    minute: parseMinute(env.WORKER_CRON_MINUTE, WORKER_SCHEDULE_DEFAULT_MINUTE),
  };
}

/** ms hasta las próximas HH:MM Lima (hora local de Lima). Puro, testeable. */
export function msUntilNextLimaRun(nowMs: number, hour: number, minute: number): number {
  const limaNow = new Date(nowMs + LIMA_OFFSET_MS);
  const y = limaNow.getUTCFullYear();
  const mo = limaNow.getUTCMonth();
  const d = limaNow.getUTCDate();
  let target = Date.UTC(y, mo, d, hour, minute) - LIMA_OFFSET_MS;
  if (target < nowMs) target += 24 * 3_600_000;
  return target - nowMs;
}
