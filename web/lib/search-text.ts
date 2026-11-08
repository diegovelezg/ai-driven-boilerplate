// Texto de búsqueda compartido (inventario, CRM, marcas, órdenes).
// Misma normalización ES en TS y en los RPC (lower + imm_unaccent):
// tildes, mayúsculas y espacios dejan de importar. Puro, testeable.
export function normalizeSearch(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens de búsqueda, tope 6 (paridad con los RPC). */
export function tokenizeSearch(q: string, max = 6): string[] {
  return normalizeSearch(q)
    .split(" ")
    .filter((t) => t.length > 0)
    .slice(0, Math.max(1, max));
}

/** Une campos al haystack normalizado (ignora vacíos). */
export function joinHaystack(parts: Array<unknown>): string {
  return normalizeSearch(
    parts
      .filter((v) => String(v ?? "").trim() !== "")
      .join(" "),
  );
}

/** AND de tokens sobre un haystack ya normalizado. */
export function matchTokens(haystackNormalized: string, tokens: string[]): boolean {
  return tokens.every((t) => haystackNormalized.includes(t));
}

/** Score para ordenar en JS: -1 descarta; mayor = más relevante.
 *  Base 0 si calza todo +2 prefijo del query completo +1 substring. */
export function matchScore(hayNorm: string, tokens: string[], qNorm: string): number {
  if (qNorm === "") return 0;
  if (!matchTokens(hayNorm, tokens)) return -1;
  if (hayNorm.startsWith(qNorm)) return 2;
  if (hayNorm.includes(qNorm)) return 1;
  return 0;
}
