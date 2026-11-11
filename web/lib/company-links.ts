// Vínculos explícitos agencia ↔ anunciante (pre-OI).
// Puro (testeable con tsx --test, sin BD): validación del par + fusión
// explícitos + derivados de OIs para la red del drawer Vínculos.

export type CompanyLinkOrigin = "manual" | "oi";

export interface DerivedCounter {
  id: string;
  ios: number;
}

export interface ExplicitLink {
  agency_company_id: string;
  advertiser_company_id: string;
  origin: CompanyLinkOrigin;
}

/** Valida el par antes de insertar (el servidor revalida contra la BD). */
export function validateCompanyLinkPair(input: {
  agencyCompanyId: unknown;
  advertiserCompanyId: unknown;
}): { ok: true; agencyCompanyId: string; advertiserCompanyId: string } | { ok: false; error: string } {
  const agency = typeof input.agencyCompanyId === "string" ? input.agencyCompanyId.trim() : "";
  const advertiser = typeof input.advertiserCompanyId === "string" ? input.advertiserCompanyId.trim() : "";
  if (!agency) return { ok: false, error: "Falta la agencia." };
  if (!advertiser) return { ok: false, error: "Falta el anunciante." };
  if (agency === advertiser) return { ok: false, error: "Agencia y anunciante deben ser empresas distintas." };
  return { ok: true, agencyCompanyId: agency, advertiserCompanyId: advertiser };
}

/**
 * Par explícito que una OI debe asegurar (origin='oi', best-effort).
 * - anunciante + intermediaria X → (X, anunciante).
 * - agencia que factura marca (advertiser null) o directa (agency==billing) → null.
 * - histórico pre-agency_company_id: advertiser<>billing → (billing, advertiser).
 */
export function linkPairForOrder(input: {
  advertiserCompanyId: string | null;
  billingCompanyId: string | null;
  agencyCompanyId: string | null;
}): { agencyCompanyId: string; advertiserCompanyId: string } | null {
  const billing = (input.billingCompanyId ?? "").trim() || null;
  const agency = (input.agencyCompanyId ?? "").trim() || null;
  const advertiser = (input.advertiserCompanyId ?? "").trim() || null;
  if (agency && billing && agency !== billing) {
    const adv = advertiser ?? billing;
    if (adv && agency !== adv) return { agencyCompanyId: agency, advertiserCompanyId: adv };
    return null;
  }
  if (advertiser && billing && advertiser !== billing) {
    return { agencyCompanyId: billing, advertiserCompanyId: advertiser };
  }
  return null;
}

/**
 * Reglas puras de contrapartes de la OI (nueva orden):
 * - anunciante requerido y de tipo anunciante;
 * - contratante (billing) requerido y de tipo agencia o anunciante;
 * - el contratante es el propio anunciante (directo) o una agencia.
 * La existencia, tienda y archivado los valida el servidor contra la BD.
 */
export function resolveOrderParties(input: {
  billingId: unknown;
  billingKind: unknown;
  advertiserId: unknown;
  advertiserKind: unknown;
}):
  | { ok: true; billingCompanyId: string; advertiserCompanyId: string; isDirect: boolean }
  | { ok: false; error: string; field: "advertiser" | "company" } {
  const billing = typeof input.billingId === "string" ? input.billingId.trim() : "";
  const advertiser = typeof input.advertiserId === "string" ? input.advertiserId.trim() : "";
  if (!advertiser) return { ok: false, error: "Anunciante requerido.", field: "advertiser" };
  if (input.advertiserKind !== "anunciante") {
    return { ok: false, error: "El anunciante debe ser una empresa anunciante de tu tienda.", field: "advertiser" };
  }
  if (!billing) return { ok: false, error: "Empresa requerida.", field: "company" };
  if (input.billingKind !== "agencia" && input.billingKind !== "anunciante") {
    return { ok: false, error: "El contratante debe ser una agencia o un anunciante de tu tienda.", field: "company" };
  }
  if (billing !== advertiser && input.billingKind !== "agencia") {
    return {
      ok: false,
      error: "El contratante debe ser el propio anunciante (directo) o una agencia.",
      field: "company",
    };
  }
  return { ok: true, billingCompanyId: billing, advertiserCompanyId: advertiser, isDirect: billing === advertiser };
}

export interface MergedCounter extends DerivedCounter {
  explicit: boolean;
  origin: CompanyLinkOrigin | null;
}

/**
 * Une contrapartes derivadas (con conteo de OIs) + vínculos explícitos.
 * Un explícito sin OIs entra con ios=0 (es el caso pre-OI); si ya tiene
 * OIs conserva el conteo y marca explicit=true.
 */
export function mergeNetworkCounters(
  derived: DerivedCounter[],
  explicitIds: Map<string, CompanyLinkOrigin>,
): MergedCounter[] {
  const out = new Map<string, MergedCounter>();
  for (const d of derived) {
    const origin = explicitIds.get(d.id) ?? null;
    out.set(d.id, { id: d.id, ios: d.ios, explicit: origin !== null, origin });
  }
  for (const [id, origin] of explicitIds) {
    if (!out.has(id)) out.set(id, { id, ios: 0, explicit: true, origin });
  }
  return [...out.values()];
}
