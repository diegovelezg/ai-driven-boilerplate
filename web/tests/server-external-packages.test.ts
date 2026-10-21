import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import nextConfig from "../next.config";

const ROOT = join(import.meta.dirname, "..");

/** Paquetes que revientan bundleados en el chunk SSR del standalone
 *  (2026-10-21: _getStorageClientFactories → reading 'bind' solo en prod).
 *  Todo import estático de estos en código de servidor debe estar cubierto
 *  por serverExternalPackages. */
const NODE_ONLY = ["@crawlee/cheerio"];

function serverFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === ".next") continue;
      serverFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("serverExternalPackages cubre dependencias solo-node", () => {
  it("next.config declara los paquetes que rompen el bundle SSR", () => {
    const ext = (nextConfig as { serverExternalPackages?: string[] }).serverExternalPackages ?? [];
    for (const pkg of NODE_ONLY) {
      assert.ok(ext.includes(pkg), `${pkg} falta en serverExternalPackages (next.config.ts)`);
    }
  });

  it("todo import de @crawlee/* en servidor está externalizado", () => {
    const ext = new Set(
      (nextConfig as { serverExternalPackages?: string[] }).serverExternalPackages ?? [],
    );
    const roots = ["lib", "app", "worker.ts", "agent.ts"]
      .map((r) => join(ROOT, r))
      .filter((p) => {
        try {
          statSync(p);
          return true;
        } catch {
          return false;
        }
      });
    const files = roots.flatMap((r) => (statSync(r).isDirectory() ? serverFiles(r) : [r]));
    assert.ok(files.length > 50, "el escaneo no encontró archivos de servidor");
    const found = new Set<string>();
    const re = /(?:from\s+|require\()\s*["'](@crawlee\/[^"'/]+)(?:\/[^"']*)?["']/g;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) found.add(m[1]);
    }
    assert.ok(found.size > 0, "no se detectó ningún import @crawlee/* (¿cambió el crawler?)");
    for (const pkg of found) {
      assert.ok(ext.has(pkg), `${pkg} importado en servidor pero no externalizado`);
    }
  });
});
