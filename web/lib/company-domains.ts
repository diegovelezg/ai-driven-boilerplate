// Dominios candidatos para el research de una empresa (puro, testeable).
// Fuentes en orden: companies.domain → companies.email → emails de contactos.
// Solo entran dominios enriquecibles (webmail/personales y vacíos quedan fuera).

const WEBMAIL: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.es",
  "hotmail.com.pe",
  "outlook.com",
  "outlook.es",
  "outlook.com.pe",
  "live.com",
  "live.com.pe",
  "msn.com",
  "yahoo.com",
  "yahoo.es",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "yandex.com",
  "tutanota.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com",
  "terra.com.pe",
  "yopmail.com",
  "yopmail.fr",
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "throwawaymail.com",
  "dispostable.com",
  "getnada.com",
  "maildrop.cc",
  "trashmail.com",
  "temp-mail.org",
  "fakeinbox.com",
]);

const WEBMAIL_PREFIXES = ["yahoo.", "hotmail.", "outlook.", "live."];

const INSTITUTIONAL_SUFFIXES = [
  ".edu",
  ".edu.pe",
  ".edu.co",
  ".edu.mx",
  ".edu.ar",
  ".edu.cl",
  ".edu.ec",
  ".edu.bo",
  ".gob.pe",
  ".gob.ar",
  ".gob.mx",
  ".gob.cl",
  ".gob.es",
  ".gov",
  ".mil",
  ".ac.uk",
  ".ac.nz",
];

export type CandidateSource = "company" | "company_email" | "contact" | "web";

/** Normaliza un dominio crudo: minúsculas, sin protocolo/www/puerto/ruta. "" si inválido. */
export function normalizeDomain(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let v = raw.trim().toLowerCase();
  if (!v) return "";
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0] ?? "";
  v = v.split("@").pop() ?? "";
  v = v.split(":")[0] ?? "";
  if (v.startsWith("www.")) v = v.slice(4);
  v = v.replace(/\.+$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return "";
  if (v.length > 253) return "";
  return v;
}

/** Dominio de un email: parte tras la última "@", normalizado. "" si no hay. */
export function domainFromEmail(email: unknown): string {
  if (typeof email !== "string") return "";
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return normalizeDomain(email.slice(at + 1));
}

export function isWebmail(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (!d) return false;
  if (WEBMAIL.has(d)) return true;
  return WEBMAIL_PREFIXES.some((p) => d.startsWith(p));
}

export function isInstitutional(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  return INSTITUTIONAL_SUFFIXES.some((s) => d.endsWith(s));
}

/** Enriquecible = tiene web propia probable (negocio o institucional). */
export function isEnrichableDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  if (!d || isWebmail(d)) return false;
  return true;
}

export interface DomainCandidate {
  domain: string;
  source: CandidateSource;
  /** Nº de contactos que usan este dominio (solo source=contact). */
  count: number;
}

/**
 * Candidatos ordenados: company.domain primero, luego company.email,
 * luego dominios de contactos por frecuencia. Dedupe case-insensitive,
 * solo enriquecibles, máx `limit`.
 */
export function collectCandidateDomains(
  company: { domain?: string | null; email?: string | null },
  contacts: Array<{ email?: string | null }>,
  limit = 3,
): DomainCandidate[] {
  const out: DomainCandidate[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown, source: CandidateSource, count = 1) => {
    const d = normalizeDomain(raw);
    if (!d || seen.has(d) || !isEnrichableDomain(d)) return;
    seen.add(d);
    out.push({ domain: d, source, count });
  };

  push(company.domain, "company");
  const companyEmailDomain = domainFromEmail(company.email ?? "");
  if (companyEmailDomain && companyEmailDomain !== normalizeDomain(company.domain)) {
    push(companyEmailDomain, "company_email");
  }

  const freq = new Map<string, number>();
  for (const c of contacts) {
    const d = domainFromEmail(c.email ?? "");
    if (!d || !isEnrichableDomain(d)) continue;
    freq.set(d, (freq.get(d) ?? 0) + 1);
  }
  for (const [d, count] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
    if (out.length >= limit) break;
    if (seen.has(d)) {
      const existing = out.find((o) => o.domain === d);
      if (existing && existing.source === "contact") existing.count = count;
      continue;
    }
    seen.add(d);
    out.push({ domain: d, source: "contact", count });
  }
  return out.slice(0, Math.max(1, limit));
}
