// Args del worker dedicado (issue #24). Módulo puro (sin I/O ni imports
// server): testeable con node:test vía tsx.
// Formas aceptadas: `--once`, `--poll-ms=5000` o `--poll-ms 5000`,
// `--kinds=sync,morning` o `--kinds sync,morning`.
export interface WorkerArgs {
  once: boolean;
  pollMs: number;
  /** Solo kinds conocidos; `undefined` = no se pasó `--kinds` (todos).
   *  `[]` = se pasó pero ninguno válido (el worker debe fallar, no idle). */
  kinds: string[] | undefined;
  /** Values de `--kinds` que no son kinds conocidos (se ignoran con aviso). */
  unknownKinds: string[];
}

/** Kinds que el worker sabe ejecutar (`dispatch` en `worker.ts`). */
export const KNOWN_JOB_KINDS: readonly string[] = [
  "sync",
  "morning",
  "enrichment",
  "scout",
  "strategist",
  "copywriter",
  "prospect",
];

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
    }
  }
  if (!Number.isFinite(pollMs) || pollMs < 500) pollMs = 5000;
  return { once, pollMs, kinds, unknownKinds };
}
