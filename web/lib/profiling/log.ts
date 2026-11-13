// Wrapper legacy del set perfilador: re-exporta el SSOT (`lib/log` scope `profiler`).
// Se mantiene para no tocar los 6+ call-sites existentes; código nuevo usa
// `createLogger("profiler")` directamente.
import { createLogger, type BoundFields, type Logger } from "@/lib/log";

/** Compat: `createProfilerLogger()` = `createLogger("profiler")`. */
export function createProfilerLogger(bound: BoundFields = {}): Logger {
  return createLogger("profiler", bound);
}
