// Throttle en memoria por clave (user/store/ruta) contra abuso y quema de
// cuota LLM. Sin `import "server-only"` a propósito: los tests `tsx --test`
// corren en node (igual que lib/supabase.ts). Solo usar desde server
// (actions / route handlers); nunca importar en cliente.
// Ventana fija con Map global (sobrevive HMR); en serverless multi-instancia
// es mitigación best-effort, no límite exacto distribuido.
type Bucket = { count: number; resetAt: number };
const KEY = "__rateLimitBuckets";
function buckets(): Map<string, Bucket> {
  const g = globalThis as Record<string, unknown>;
  let m = g[KEY] as Map<string, Bucket> | undefined;
  if (!m) {
    m = new Map();
    g[KEY] = m;
  }
  return m;
}

/** Ventana fija: true si se permite (y cuenta), false si excede `limit`. */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const m = buckets();
  const b = m.get(key);
  if (!b || now >= b.resetAt) {
    m.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

/** Limpieza oportunista para no crecer sin cota (1/100 llamadas). */
export function pruneRateLimits(): void {
  if (Math.floor(Math.random() * 100) !== 0) return;
  const now = Date.now();
  for (const [k, b] of buckets()) {
    if (now >= b.resetAt) buckets().delete(k);
  }
}
