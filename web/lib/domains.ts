// Clasificación y extracción de dominios de email.
// La lista de webmails aquí es reducida; la definitiva será un lookup offline (~4.500).

export type DomainType = "webmail" | "institutional" | "business";

/** Webmails/personales comunes (global + LatAm). */
const WEBMAIL: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com",
  "hotmail.com", "hotmail.es", "hotmail.com.pe",
  "outlook.com", "outlook.es", "outlook.com.pe",
  "live.com", "live.com.pe", "msn.com",
  "yahoo.com", "yahoo.es", "ymail.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net",
  "zoho.com", "yandex.com", "tutanota.com",
  "uol.com.br", "bol.com.br", "terra.com", "terra.com.pe", "speedy.com.ar",
  "facebook.com", "instagram.com",
  // Desechables / temporales (no representan un negocio).
  "yopmail.com", "yopmail.fr", "mailinator.com", "guerrillamail.com",
  "10minutemail.com", "tempmail.com", "throwawaymail.com", "sharklasers.com",
  "dispostable.com", "getnada.com", "maildrop.cc", "trashmail.com",
  "temp-mail.org", "fakeinbox.com",
]);

/** Familias de webmail con variantes regionales (yahoo.com.mx, hotmail.es, …). */
const WEBMAIL_PREFIXES = ["yahoo.", "hotmail.", "outlook.", "live."];

/** Sufijos institucionales/gubernamentales (LatAm + genéricos). */
const INSTITUTIONAL_SUFFIXES = [
  ".edu", ".edu.pe", ".edu.co", ".edu.mx", ".edu.ar", ".edu.cl", ".edu.ec", ".edu.bo",
  ".gob.pe", ".gob.ar", ".gob.mx", ".gob.cl", ".gob.es",
  ".gov", ".mil", ".ac.uk", ".ac.nz",
];

export interface DomainClass {
  domain: string;
  type: DomainType | "none";
  /** true si tiene web propia y por tanto vale la pena enriquecer. */
  enrichable: boolean;
}

/** Dominio de un email: parte tras la última "@", en minúsculas. "" si no hay. */
export function domainFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).trim().toLowerCase();
}

export function classifyDomain(domain: string): DomainClass {
  const d = domain.trim().toLowerCase();
  if (!d) return { domain: d, type: "none", enrichable: false };
  if (WEBMAIL.has(d) || WEBMAIL_PREFIXES.some((p) => d.startsWith(p))) {
    return { domain: d, type: "webmail", enrichable: false };
  }
  if (INSTITUTIONAL_SUFFIXES.some((s) => d.endsWith(s))) {
    return { domain: d, type: "institutional", enrichable: true };
  }
  return { domain: d, type: "business", enrichable: true };
}
