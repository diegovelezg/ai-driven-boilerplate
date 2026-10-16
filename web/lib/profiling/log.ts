// Logger del set perfilador: misma forma que lib/log pero sin "server-only"
// para que los smoke scripts (tsx) puedan correr el pipeline.
// Solo server/scripts (escribe .data/).
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), ".data");

/** Best-effort a consola + `.data/profiler.log` (grep-friendly). */
export function createProfilerLogger(): (line: string) => void {
  const file = join(LOG_DIR, "profiler.log");
  return (line: string): void => {
    const msg = `[${new Date().toISOString()}] ${line}`;
    console.log(`[profiler] ${msg}`);
    mkdir(LOG_DIR, { recursive: true })
      .then(() => appendFile(file, msg + "\n", "utf-8"))
      .catch(() => {
        // Sin archivo: la consola ya lo tiene.
      });
  };
}
