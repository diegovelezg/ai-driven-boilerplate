// Formateo de display para nombres/empresas.

// Conectores que se dejan en minúscula dentro de un nombre propio.
const CONNECTORS = new Set([
  "de", "del", "la", "las", "los", "y", "e",
  "da", "do", "dos", "van", "von", "der", "di", "du", "la",
]);

/**
 * Title Case, pero SOLO si el texto está todo en mayúsculas.
 * Así arregla "SANTA CRUZ CRUZADO JEYMI LUIS" → "Santa Cruz Cruzado Jeymi Luis"
 * sin romper valores ya bien escritos ("TuPantalla", "Laser Med Solutions", "YouTube").
 */
export function smartTitleCase(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = input.trim();
  if (!s || !/[a-záéíóúñü]/i.test(s)) return s;
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && CONNECTORS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
