// Cuentas que atiende un contacto de agencia (contacto → anunciante).
// Puro (testeable con tsx --test, sin BD): validación del set + normalización.
// La pertenencia (contacto de la agencia, kinds, vínculo previo en
// crm_company_links) la revalida el servidor contra la BD.

export interface ContactAccountInput {
  contactId: unknown;
  agencyCompanyId: unknown;
  advertiserCompanyId: unknown;
}

export interface ContactAccountSet {
  contactId: string;
  agencyCompanyId: string;
  /** Anunciantes que atiende, normalizados (únicos, sin vacíos ni auto-par). */
  advertiserCompanyIds: string[];
}

/** Normaliza el set que declara a qué anunciantes atiende un contacto. */
export function normalizeContactAccountSet(input: {
  contactId: unknown;
  agencyCompanyId: unknown;
  advertiserCompanyIds: unknown;
}): { ok: true; value: ContactAccountSet } | { ok: false; error: string } {
  const contactId = typeof input.contactId === "string" ? input.contactId.trim() : "";
  if (!contactId) return { ok: false, error: "Falta el contacto." };
  const agencyCompanyId = typeof input.agencyCompanyId === "string" ? input.agencyCompanyId.trim() : "";
  if (!agencyCompanyId) return { ok: false, error: "Falta la agencia del contacto." };
  const raw = Array.isArray(input.advertiserCompanyIds) ? input.advertiserCompanyIds : [];
  const seen = new Set<string>();
  for (const r of raw) {
    const id = typeof r === "string" ? r.trim() : "";
    if (!id || id === agencyCompanyId || id === contactId) continue;
    seen.add(id);
  }
  return { ok: true, value: { contactId, agencyCompanyId, advertiserCompanyIds: [...seen] } };
}

/** Valida un par suelto (usado por mensajes de error puntuales). */
export function validateContactAccountPair(input: ContactAccountInput):
  | { ok: true; contactId: string; agencyCompanyId: string; advertiserCompanyId: string }
  | { ok: false; error: string } {
  const contactId = typeof input.contactId === "string" ? input.contactId.trim() : "";
  const agencyCompanyId = typeof input.agencyCompanyId === "string" ? input.agencyCompanyId.trim() : "";
  const advertiserCompanyId = typeof input.advertiserCompanyId === "string" ? input.advertiserCompanyId.trim() : "";
  if (!contactId) return { ok: false, error: "Falta el contacto." };
  if (!agencyCompanyId) return { ok: false, error: "Falta la agencia del contacto." };
  if (!advertiserCompanyId) return { ok: false, error: "Falta el anunciante." };
  if (agencyCompanyId === advertiserCompanyId) {
    return { ok: false, error: "Agencia y anunciante deben ser empresas distintas." };
  }
  return { ok: true, contactId, agencyCompanyId, advertiserCompanyId };
}

export interface AgencyAttendantsSet {
  agencyCompanyId: string;
  advertiserCompanyId: string;
  /** Contactos de la agencia que atienden al anunciante (únicos). */
  contactIds: string[];
}

/** Normaliza el set vista-anunciante: qué contactos de una agencia lo atienden. */
export function normalizeAgencyAttendantsSet(input: {
  agencyCompanyId: unknown;
  advertiserCompanyId: unknown;
  contactIds: unknown;
}): { ok: true; value: AgencyAttendantsSet } | { ok: false; error: string } {
  const agencyCompanyId = typeof input.agencyCompanyId === "string" ? input.agencyCompanyId.trim() : "";
  if (!agencyCompanyId) return { ok: false, error: "Falta la agencia." };
  const advertiserCompanyId = typeof input.advertiserCompanyId === "string" ? input.advertiserCompanyId.trim() : "";
  if (!advertiserCompanyId) return { ok: false, error: "Falta el anunciante." };
  if (agencyCompanyId === advertiserCompanyId) {
    return { ok: false, error: "Agencia y anunciante deben ser empresas distintas." };
  }
  const raw = Array.isArray(input.contactIds) ? input.contactIds : [];
  const contactIds = [...new Set(raw.map((r) => (typeof r === "string" ? r.trim() : "")).filter((s) => s !== ""))];
  return { ok: true, value: { agencyCompanyId, advertiserCompanyId, contactIds } };
}
