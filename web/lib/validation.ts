// SSOT de validación cliente compartida (issue #8 P2).
// EMAIL_RE vivía copiado en contacts/new/nuevo-form, empresa-drawer y
// lib/crm.ts (más un extractor global distinto en lib/retrieval.ts que NO
// se toca: extrae, no valida). Un solo patrón + helper; los forms lo importan.
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isValidEmail(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.trim();
  if (!v || v.length > 320) return false;
  return EMAIL_RE.test(v);
}
