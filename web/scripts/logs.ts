// Consulta de logs SSOT (`web/lib/log.ts`).
// Uso:
//   tsx scripts/logs.ts --level=error --tail=50
//   tsx scripts/logs.ts --scope=brief --tail=100
//   tsx scripts/logs.ts --grep="run=abc123" --tail=200
//   tsx scripts/logs.ts --level=warn --since=2026-11-11 --tail=200
//   tsx scripts/logs.ts --list   (scopes con archivo en .data/)
// Flags: --scope= --level=debug|info|warn|error --grep= --since=ISO|ms --tail=N --list
import { listLogScopes, queryLogs, PROCESSES, type LogLevel } from "@/lib/log";

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const p = `--${name}=`;
  const hit = args.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length).trim() || null : null;
};
const has = (name: string): boolean => args.includes(`--${name}`);

async function main(): Promise<void> {
  if (has("list")) {
    const scopes = await listLogScopes();
    const known = [...PROCESSES.crud, ...PROCESSES.ai, ...PROCESSES.inbox, ...PROCESSES.api, ...PROCESSES.system];
    console.log(`archivos: ${scopes.length ? scopes.join(", ") : "(sin .data/*.log)"}`);
    console.log(`catálogo: ${known.join(", ")}`);
    const missing = known.filter((s) => !scopes.includes(s));
    if (missing.length > 0) console.log(`sin archivo aún (sin eventos): ${missing.join(", ")}`);
    return;
  }
  const levelRaw = (opt("level") ?? "").toLowerCase();
  const level = ["debug", "info", "warn", "error"].includes(levelRaw) ? (levelRaw as LogLevel) : undefined;
  const lines = await queryLogs({
    scope: opt("scope") ?? undefined,
    level,
    grep: opt("grep") ?? undefined,
    since: opt("since") ?? undefined,
    tail: Math.max(1, Number.parseInt(opt("tail") ?? "100", 10) || 100),
  });
  for (const l of lines) console.log(l);
  console.error(`(${lines.length} líneas)`);
}

main().catch((e) => {
  console.error(`LOGS FAIL: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
