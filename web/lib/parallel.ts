// Pool de concurrencia acotada para tareas I/O-bound (red/LLM).
// Regla general: úsalo cuando los ítems sean independientes (upserts por clave,
// contadores conmutativos). JS es single-thread: el reparto es seguro.
// No usar para trabajo CPU-bound ni cuando el orden importe.

/**
 * Aplica `fn` a cada ítem con hasta `concurrency` workers en paralelo.
 * Devuelve resultados en el orden de `items`. Si `fn` lanza, el error se
 * propaga tras esperar a los workers en vuelo (los demás ítems se pierden:
 * para progreso parcial con fallos por ítem, captura dentro de `fn`).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = Math.max(1, Math.floor(concurrency));
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}
