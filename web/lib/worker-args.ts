// Args del worker dedicado (issue #24). Módulo puro (sin I/O ni imports
// server): testeable con node:test vía tsx.
// Formas aceptadas: `--once`, `--poll-ms=5000` o `--poll-ms 5000`,
// `--kinds=sync,morning` o `--kinds sync,morning`.
export interface WorkerArgs {
  once: boolean;
  pollMs: number;
  kinds: string[] | undefined;
}

export function parseWorkerArgs(argv: string[], envPollMs?: string | undefined): WorkerArgs {
  let once = false;
  let pollMs = Number(envPollMs ?? 5000);
  let kinds: string[] | undefined = undefined;
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
      const list = a
        .split("=")[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length > 0) kinds = list;
    } else if (a === "--kinds") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        const list = next
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (list.length > 0) kinds = list;
        i += 1;
      }
    }
  }
  if (!Number.isFinite(pollMs) || pollMs < 500) pollMs = 5000;
  return { once, pollMs, kinds };
}
