// CRM base: tipos + validación pura (sin BD: testeable con tsx --test).
// Diseño (nov-2026, DOOH Smart Media): cada empresa tiene UN tipo obligatorio.
// - agencia: central de medios (contrata PARA marcas; puede pagar o no).
// - anunciante: marca/empresa que publicita (contrata directo o vía agencia).
// - proveedor: dueño de inventario externo.
// La casa (red propia / operadora) NO es una empresa del CRM: vive en
// venues/company_id y se excluye del listado (kind IS NULL filtrado en
// listCrmCompanies). Por eso el tipo es requerido en todos los ingresos.
// La marca publicitada es METADATO del pedido (io_orders.brand), no
// una empresa: la misma marca puede venir vía agencia o directo.
// Cliente/prospecto NO se guardan: se derivan (¿tiene IO firmada?).

// SSOT email: el patrón vive en lib/validation.ts (issue #8 P2).
import { isCountryCode } from "@/lib/countries";
import { isValidEmail } from "@/lib/validation";

export const COMPANY_KINDS = ["agencia", "anunciante", "proveedor"] as const;

export type CompanyKind = (typeof COMPANY_KINDS)[number];

export const COMPANY_KIND_LABELS: Record<CompanyKind, string> = {
  agencia: "Agencia",
  anunciante: "Anunciante",
  proveedor: "Proveedor",
};

export function isCompanyKind(v: unknown): v is CompanyKind {
  return typeof v === "string" && (COMPANY_KINDS as readonly string[]).includes(v);
}

export interface CompanyInput {
  name: string;
  kind?: CompanyKind | null;
  tax_id?: string | null;
  domain?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  notes?: string | null;
  external_ref?: string | null;
}

export interface ContactInput {
  company_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  job_title?: string | null;
  is_primary?: boolean;
  notes?: string | null;
}

function cleanStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (s.length > max) return null;
  return s;
}

export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!d.includes(".") || d.length > 253) return null;
  return d;
}

export function normalizeCompany(input: CompanyInput): { ok: true; value: Required<Pick<CompanyInput, "name">> & Omit<CompanyInput, "name"> } | { ok: false; error: string } {
  const name = cleanStr(input.name, 200);
  if (!name) return { ok: false, error: "Nombre de empresa requerido (máx 200)." };
  const domain = input.domain === undefined || input.domain === null || input.domain === "" ? null : normalizeDomain(input.domain);
  if (input.domain && domain === null) return { ok: false, error: "Web inválida (p. ej. acme.pe)." };
  const email = cleanStr(input.email, 320);
  if (input.email && !email) return { ok: false, error: "Email inválido." };
  if (email && !isValidEmail(email)) return { ok: false, error: "Email inválido." };
  // País: ISO2 real (misma regla que el cliente company-validation:
  // `isCountryCode`). El servidor era más laxo (cualquier 2 letras) y dejaba
  // pasar "AA": ahora espejo exacto, el cliente nunca bloquea un valor válido.
  const countryRaw = cleanStr(input.country, 2)?.toUpperCase() ?? null;
  if (input.country && (!countryRaw || !isCountryCode(countryRaw))) {
    return { ok: false, error: "País inválido (ISO2, p. ej. PE)." };
  }
  const country = countryRaw;
  const external_ref = cleanStr(input.external_ref, 120);
  if (input.external_ref && !external_ref) return { ok: false, error: "external_ref inválido." };
  const kind = input.kind ?? null;
  if (!isCompanyKind(kind)) return { ok: false, error: "Tipo requerido: agencia, anunciante o proveedor." };
  return {
    ok: true,
    value: {
      name,
      kind,
      tax_id: cleanStr(input.tax_id, 40),
      domain,
      email,
      phone: cleanStr(input.phone, 40),
      address: cleanStr(input.address, 300),
      city: cleanStr(input.city, 120),
      country,
      notes: cleanStr(input.notes, 2000),
      external_ref,
    },
  };
}

export function normalizeContact(input: ContactInput): { ok: true; value: ContactInput } | { ok: false; error: string } {
  const email = cleanStr(input.email, 320);
  const phone = cleanStr(input.phone, 40);
  if (!email && !phone) return { ok: false, error: "Contacto requiere email o teléfono." };
  if (email && !isValidEmail(email)) return { ok: false, error: "Email inválido." };
  return {
    ok: true,
    value: {
      company_id: typeof input.company_id === "string" && input.company_id ? input.company_id : null,
      first_name: cleanStr(input.first_name, 120),
      last_name: cleanStr(input.last_name, 120),
      email,
      phone,
      job_title: cleanStr(input.job_title, 120),
      is_primary: input.is_primary === true,
      notes: cleanStr(input.notes, 2000),
    },
  };
}

/** Etiqueta del tipo para la UI. La casa no lista, así que null = dato legacy. */
export function kindLabel(kind: string | null): string {
  return kind !== null && isCompanyKind(kind) ? COMPANY_KIND_LABELS[kind] : "—";
}
