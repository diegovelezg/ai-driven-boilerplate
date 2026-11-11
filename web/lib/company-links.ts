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
