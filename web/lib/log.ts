import "server-only";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), ".data");

/**
 * Logger best-effort a consola + archivo (`.data/<name>.log`).
 * Si falla la escritura a archivo, la línea ya quedó en consola.
 */
export function createLogger(name: string): (line: string) => void {
  const file = join(LOG_DIR, `${name}.log`);
  return (line: string): void => {
    const msg = `[${new Date().toISOString()}] ${line}`;
    console.log(`[${name}] ${msg}`);
    mkdir(LOG_DIR, { recursive: true })
      .then(() => appendFile(file, msg + "\n", "utf-8"))
      .catch(() => {
        // Sin archivo de log: la consola ya lo tiene.
      });
  };
}
