// Picker de empresas: filtro fuzzy con el mismo mecanismo que el picker
// de pantallas y los listados — normalización ES + AND de tokens + ranking.
// Client-safe a propósito: lo importa el picker ("use client") y los tests.
// Nunca server-libs aquí.
import { joinHaystack, matchScore, normalizeSearch, tokenizeSearch } from "./search-text";

export interface CompanyPickInput {
  name?: unknown;
  tax_id?: unknown;
  domain?: unknown;
  city?: unknown;
}

/** Haystack normalizado de una empresa del picker (nombre + fiscal + web +
 *  ciudad: mismos campos que indexa `crm_search_companies`). */
export function pickCompanyHaystack(c: CompanyPickInput): string {
  return joinHaystack([c.name, c.tax_id, c.domain, c.city]);
}

/** Filtro fuzzy del picker: sin query devuelve todo en orden; con query
 *  conserva solo los que calzan todos los tokens, por relevancia
 *  (estable: conserva el orden alfabético del servidor dentro del score).
 *  Puro y testeable. En modo servidor el padre ya filtra: este refinado
 *  local es idempotente sobre el top-N recibido. */
export function filterPickCompanies<T extends CompanyPickInput>(companies: T[], q: string): T[] {
  const tokens = tokenizeSearch(q);
  if (tokens.length === 0) return companies;
  const qNorm = normalizeSearch(q);
  const scored = companies
    .map((c) => ({ c, score: matchScore(pickCompanyHaystack(c), tokens, qNorm) }))
    .filter((x) => x.score >= 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.c);
}
