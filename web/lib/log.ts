// SSOT de logging (server/scripts). Único punto para debuguear procesos.
//
// Uso:
//   import { createLogger } from "@/lib/log";
//   const log = createLogger("profiler", { storeId, runId });
//   log.info("pipeline synthesis", { arch, conf });
//   log("texto legacy"); // = info (compat con createLogger anterior)
//
// Contrato:
// - Niveles: debug/info/warn/error. `LOG_LEVEL` (default `info`).
//   `ADK_LOG_VERBOSE=0` legacy: scope `adk` sube el mínimo a `warn`.
// - Salida: consola (mapeo debug/info/warn/error) + best-effort a archivo:
//   `.data/<scope>.log` (por proceso) y `.data/app.log` (combinado).
// - Formato grep-friendly: `[ISO] [LEVEL] [scope] mensaje k=v k=v`.
// - Nunca lanza. Trunca con `LOG_MAX` (default 2000, legacy `ADK_LOG_MAX`).
// - Redacta secretos básicos (Bearer, sk-*, password/token en ctx).
//
// Solo server/scripts (usa `node:fs`; nunca importar en Client Components).
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Scope = proceso. Abierto a cualquier string; los conocidos van aquí. */
export type LogScope =
  | "worker"
  | "adk"
  | "profiler"
  | "enrichment"
  | "brief"
  | "api"
  | "tenant"
  | "llm-usage"
  | "background"
  | "scripts"
  | (string & {});

export type LogContext = Record<string, unknown>;

export interface BoundFields extends LogContext {
  storeId?: string | null;
  runId?: string | null;
  process?: string | null;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function envLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

function maxLen(): number {
  const n = Number(process.env.LOG_MAX ?? process.env.ADK_LOG_MAX ?? 2000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

function minLevelFor(scope: string): LogLevel {
  const base = envLevel();
  // Compat: ADK_LOG_VERBOSE=0 recortaba a errores+resumen.
  if (scope === "adk" && process.env.ADK_LOG_VERBOSE === "0") {
    return LEVEL_ORDER[base] > LEVEL_ORDER.warn ? base : "warn";
  }
  return base;
}

/** true si `level` pasa el filtro actual para `scope`. Pura (testeable). */
export function shouldLog(scope: string, level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevelFor(scope)];
}

/** Redacción mínima de secretos en texto libre. Pura (testeable). */
export function redactSecrets(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/g, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9\-_]{4,}\b/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)["']?[^"'\s,}]+["']?/gi, "$1[redacted]");
}

function safeStr(v: unknown): string {
  if (v === null || v === undefined) return "?";
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  try {
    const s = JSON.stringify(v);
    return s ?? "?";
  } catch {
    return "[no-serializable]";
  }
}

const SECRET_KEYS = new Set(["apikey", "api_key", "authorization", "token", "secret", "password"]);

/** `k=v` con redacción de claves sensibles. Pura (testeable). */
export function serializeContext(ctx: LogContext, max: number): string {
  const parts: string[] = [];
  for (const [k, raw] of Object.entries(ctx)) {
    if (raw === null || raw === undefined) continue;
    const v = SECRET_KEYS.has(k.toLowerCase()) ? "[redacted]" : safeStr(raw);
    parts.push(`${k}=${v}`);
  }
  const joined = parts.join(" ");
  const m = max > 0 ? max : 2000;
  return joined.length > m ? `${joined.slice(0, m)}…[truncado ${joined.length - m}]` : joined;
}

/** Línea final grep-friendly. Pura (testeable). */
export function formatLogLine(
  scope: string,
  level: LogLevel,
  msg: string,
  ctx: LogContext = {},
  now: Date = new Date(),
): string {
  const m = maxLen();
  let text = redactSecrets(msg);
  if (text.length > m) text = `${text.slice(0, m)}…[truncado ${text.length - m}]`;
  const extra = serializeContext(ctx, m);
  return `[${now.toISOString()}] [${level}] [${scope}]${extra ? ` ${text} ${extra}` : ` ${text}`}`;
}

const LOG_DIR = join(process.cwd(), ".data");
let dirReady: Promise<void> | null = null;

function writeFiles(scope: string, line: string): void {
  try {
    dirReady ??= mkdir(LOG_DIR, { recursive: true }).then(() => undefined);
    const files = [join(LOG_DIR, `${scope}.log`), join(LOG_DIR, "app.log")];
    void dirReady
      .then(() => Promise.all(files.map((f) => appendFile(f, line + "\n", "utf-8"))))
      .catch(() => {});
  } catch {
    // best-effort: la consola ya lo tiene
  }
}

function emit(scope: string, bound: BoundFields, level: LogLevel, msg: string, ctx: LogContext = {}): void {
  if (!shouldLog(scope, level)) return;
  const line = formatLogLine(scope, level, msg, { ...bound, ...ctx });
  const tagged = `[${scope}] ${line}`;
  if (level === "debug") console.debug(tagged);
  else if (level === "warn") console.warn(tagged);
  else if (level === "error") console.error(tagged);
  else console.log(tagged);
  writeFiles(scope, line);
}

export interface Logger {
  /** Compat legacy: `log("texto")` = info. */
  (msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string | unknown, ctx?: LogContext): void;
  /** Deriva un logger con campos fijos (storeId/runId/process/...). */
  child(extra: BoundFields): Logger;
}

/**
 * Crea el logger de un proceso. `bound` fija contexto (storeId, runId...).
 * Ejemplo: `createLogger("api", { process: "brief" })`.
 */
export function createLogger(scope: LogScope, bound: BoundFields = {}): Logger {
  const base = (msg: string, ctx: LogContext = {}): void => emit(scope, bound, "info", msg, ctx);
  const logger = base as Logger;
  logger.debug = (msg, ctx = {}) => emit(scope, bound, "debug", msg, ctx);
  logger.info = (msg, ctx = {}) => emit(scope, bound, "info", msg, ctx);
  logger.warn = (msg, ctx = {}) => emit(scope, bound, "warn", msg, ctx);
  logger.error = (msg, ctx = {}) => {
    const text = msg instanceof Error ? `${msg.message} [${msg.stack?.split("\n").slice(1, 4).map((l) => l.trim()).filter(Boolean).join(" <- ") ?? ""}]` : safeStr(msg);
    emit(scope, bound, "error", text, ctx);
  };
  logger.child = (extra: BoundFields) => createLogger(scope, { ...bound, ...extra });
  return logger;
}

/** Atajo sin scope fijo para API routes: `apiLog("brief", "...", { storeId })`. */
export function apiLog(process: string, msg: string, ctx: LogContext = {}): void {
  createLogger("api", { process }).info(msg, ctx);
}

/* ------------------------------------------------------------------ */
/* Catálogo de procesos cubiertos (SSOT).                              */
/* ------------------------------------------------------------------ */

/**
 * Todos los procesos que deben loguear vía este SSOT. Sirve de checklist
 * para cobertura y de `--scope` válido en `scripts/logs.ts`:
 * - crud: server actions de mutación (empresas, contactos, OIs, pantallas,
 *   muro, miembros, settings). Scope = nombre del archivo sin `-actions`.
 * - ai: agentes y pipeline LLM (chat ADK, perfilador, enrichment...).
 * - inbox: ciclo diario del muro (brief matutino + wall/inbox).
 * - api: routes HTTP (scope `api`, `process` = nombre de la ruta).
 * - system: worker, tenant, auth, corridas background, scripts.
 */
export const PROCESSES = {
  crud: ["crm", "orders", "order-flow", "screens", "insights", "members", "settings"],
  ai: ["chat", "adk", "profiler", "enrichment", "investigate", "verticals", "company-research", "llm-usage"],
  inbox: ["brief", "wall"],
  api: ["api"],
  system: ["worker", "tenant", "auth", "background", "scripts"],
} as const;

/* ------------------------------------------------------------------ */
/* trace(): envuelve una unidad de trabajo con start/ok/error + ms.    */
/* ------------------------------------------------------------------ */

/**
 * Envuelve una acción/ruta/job: `debug start`, `info ok ms=`, `error ms=`
 * (y relanza). Para que un fallo se pueda consultar después por
 * `scope` + `action` en `.data/app.log`.
 *
 * ```ts
 * return trace("brief", "runBriefJob", () => runBriefJob(storeId, opts), { storeId });
 * ```
 */
export async function trace<T>(
  scope: LogScope,
  name: string,
  fn: () => Promise<T>,
  ctx: LogContext = {},
): Promise<T> {
  const log = createLogger(scope);
  const t0 = Date.now();
  log.debug(`${name} start`, ctx);
  try {
    const out = await fn();
    log.info(`${name} ok`, { ...ctx, ms: Date.now() - t0 });
    return out;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(safeStr(e));
    log.error(err, { ...ctx, action: name, ms: Date.now() - t0 });
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Consulta: parse + filtro (puros) y lectura de `.data/*.log`.       */
/* ------------------------------------------------------------------ */

export interface ParsedLogLine {
  ts: string;
  level: string;
  scope: string;
  msg: string;
  raw: string;
}

const LINE_RE = /^\[(.*?)\] \[(.*?)\] \[(.*?)\] ?(.*)$/;

/** Parsea una línea del formato SSOT. null si no calza. Pura (testeable). */
export function parseLogLine(line: string): ParsedLogLine | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return { ts: m[1], level: m[2], scope: m[3], msg: m[4] ?? "", raw: line };
}

export interface LogFilter {
  /** Nivel mínimo (debug < info < warn < error). */
  level?: LogLevel;
  /** Substring case-insensitive sobre la línea cruda. */
  grep?: string;
  /** Solo líneas con ts >= since (ISO o epoch ms). */
  since?: string | number;
}

/** Filtra líneas ya leídas. Pura (testeable). */
export function filterLogLines(lines: string[], f: LogFilter = {}): string[] {
  const min = f.level ? LEVEL_ORDER[f.level] : 0;
  const needle = (f.grep ?? "").toLowerCase();
  const sinceMs =
    typeof f.since === "number"
      ? f.since
      : typeof f.since === "string" && f.since
        ? Date.parse(f.since)
        : NaN;
  return lines.filter((raw) => {
    if (!raw.trim()) return false;
    if (needle && !raw.toLowerCase().includes(needle)) return false;
    const p = parseLogLine(raw);
    if (!p) return needle ? true : false;
    if ((LEVEL_ORDER[p.level as LogLevel] ?? 0) < min) return false;
    if (Number.isFinite(sinceMs) && Number.isNaN(Date.parse(p.ts))) return false;
    if (Number.isFinite(sinceMs) && Date.parse(p.ts) < (sinceMs as number)) return false;
    return true;
  });
}

export interface LogQuery extends LogFilter {
  /** Scope = archivo `.data/<scope>.log`. Sin scope = `app.log` (combinado). */
  scope?: string;
  /** Últimas N líneas (default 100, tope 2000). */
  tail?: number;
}

/**
 * Lee y filtra logs de `.data/`. Solo server/scripts (node:fs).
 * `queryLogs({ level: "error", tail: 50 })` = últimos 50 errores de todo.
 */
export async function queryLogs(q: LogQuery = {}): Promise<string[]> {
  const tail = Math.min(Math.max(q.tail ?? 100, 1), 2000);
  const file = join(LOG_DIR, `${q.scope ?? "app"}.log`);
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  return filterLogLines(lines, q).slice(-tail);
}

/** Scopes con archivo de log existente (para `scripts/logs.ts --list`). */
export async function listLogScopes(): Promise<string[]> {
  try {
    const files = await readdir(LOG_DIR);
    return files.filter((f) => f.endsWith(".log")).map((f) => f.slice(0, -4)).sort();
  } catch {
    return [];
  }
}
