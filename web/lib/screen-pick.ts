// Picker de pantallas (nueva orden): filtro fuzzy con el mismo mecanismo
// que la vista principal de screens y el muro — normalización ES + AND de
// tokens + ranking. Client-safe a propósito: lo importa el form
// ("use client") y los tests. Nunca server-libs aquí.
import { joinHaystack, matchScore, normalizeSearch, tokenizeSearch } from "./search-text";

export interface ScreenPickInput {
  name?: unknown;
  detail?: unknown;
}

/** Haystack normalizado de una pantalla del picker (nombre + detalle, que ya
 *  trae código, sede, distrito, ciudad, proveedor, tecnología y resolución:
 *  mismos campos que indexa `screenHaystack` de la vista principal). */
export function pickScreenHaystack(s: ScreenPickInput): string {
  return joinHaystack([s.name, s.detail]);
}

/** Filtro fuzzy del picker: si no hay query devuelve todo en orden;
 *  si hay, conserva solo los que calzan todos los tokens, por relevancia
 *  (estable: conserva el orden alfabético del servidor dentro del score).
 *  Puro y testeable. */
export function filterPickScreens<T extends ScreenPickInput>(screens: T[], q: string): T[] {
  const tokens = tokenizeSearch(q);
  if (tokens.length === 0) return screens;
  const qNorm = normalizeSearch(q);
  const scored = screens
    .map((s) => ({ s, score: matchScore(pickScreenHaystack(s), tokens, qNorm) }))
    .filter((x) => x.score >= 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.s);
}
