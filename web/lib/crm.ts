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
import { isAdvertiserCategory, type AdvertiserCategoryCode } from "@/lib/advertiser-categories";
import { isProviderType, type ProviderTypeCode } from "@/lib/provider-types";
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

/** Default del filtro de empresas: agencia + anunciante (sin proveedor). */
export const DEFAULT_COMPANY_KINDS: readonly CompanyKind[] = ["agencia", "anunciante"];

function collectKindTokens(raw: unknown, out: string[]): boolean {
  // true = había parámetro presente (aunque sea vacío/inválido).
  if (raw === undefined || raw === null) return false;
  const arr = Array.isArray(raw) ? raw : [raw];
  let present = false;
  for (const v of arr) {
    if (typeof v !== "string") continue;
    // URLSearchParams decodifica "?type" sin valor como "".
    present = true;
    for (const t of v.split(",")) {
      const s = t.trim().toLowerCase();
      if (s) out.push(s);
    }
  }
  return present;
}

/**
 * Parsea el filtro multiselect de tipo (?type / ?tipo, repetido o coma).
 * - Sin parámetro → default (agencia + anunciante).
 * - "all"/"todo(s)" → los 3 tipos. "none"/"ninguno" → [] (ninguno).
 * - Con parámetro pero sin kinds válidos → default (links legacy/typos no rompen).
 * Orden de salida = orden canónico de COMPANY_KINDS.
 */
export function parseCompanyKinds(raw: unknown): CompanyKind[] {
  const tokens: string[] = [];
  const present = collectKindTokens(raw, tokens);
  if (!present) return [...DEFAULT_COMPANY_KINDS];
  const lower = tokens.map((t) => t);
  if (lower.includes("all") || lower.includes("todo") || lower.includes("todos") || lower.includes("todas")) {
    return [...COMPANY_KINDS];
  }
  if (lower.includes("none") || lower.includes("ninguno") || lower.includes("ninguna") || lower.includes("sin")) {
    return [];
  }
  const set = new Set<CompanyKind>();
  for (const t of lower) {
    if (isCompanyKind(t)) set.add(t);
  }
  if (set.size === 0) return [...DEFAULT_COMPANY_KINDS];
  return COMPANY_KINDS.filter((k) => set.has(k));
}

/** ¿La selección es el default (agencia + anunciante)? Orden-insensible. */
export function isDefaultCompanyKinds(kinds: readonly CompanyKind[]): boolean {
  return (
    kinds.length === DEFAULT_COMPANY_KINDS.length &&
    DEFAULT_COMPANY_KINDS.every((k) => (kinds as readonly string[]).includes(k))
  );
}

/**
 * Serializa la selección a query (?type=). null = omitir (es el default).
 * "all" nunca se emite: los 3 tipos se serializan explícitos.
 */
export function serializeCompanyKinds(kinds: readonly CompanyKind[]): string | null {
  if (isDefaultCompanyKinds(kinds)) return null;
  if (kinds.length === 0) return "none";
  return COMPANY_KINDS.filter((k) => (kinds as readonly string[]).includes(k)).join(",");
}

/** Etiqueta corta del filtro multiselect (trigger). */
export function companyKindsLabel(kinds: readonly CompanyKind[]): string {
  if (kinds.length === 0) return "Sin tipo";
  if (kinds.length === COMPANY_KINDS.length) return "Todo tipo";
  return COMPANY_KINDS.filter((k) => (kinds as readonly string[]).includes(k))
    .map((k) => COMPANY_KIND_LABELS[k])
    .join(", ");
}

/** Estado de borrado lógico para listados (default: solo activas). */
export type CrmStatusFilter = "active" | "archived" | "all";

export const CRM_STATUS_VALUES: CrmStatusFilter[] = ["active", "archived", "all"];

export const CRM_STATUS_LABELS: Record<CrmStatusFilter, string> = {
  active: "Activas",
  archived: "Archivadas",
  all: "Todas",
};

export function isCrmStatusFilter(v: unknown): v is CrmStatusFilter {
  return v === "active" || v === "archived" || v === "all";
}

export interface CompanyInput {
  name: string;
  /** Razón social / nombre legal registrado (name = nombre comercial). */
  legal_name?: string | null;
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
  /** Vertical IAB 2.0 (IAB1–IAB24). SSOT en lib/advertiser-categories. */
  category_iab?: string | null;
  /** Subtipo de proveedor. Solo con kind = 'proveedor'. */
  provider_type?: string | null;
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

export function normalizeCompany(input: CompanyInput): { ok: true; value: Required<Pick<CompanyInput, "name" | "legal_name" | "tax_id" | "address" | "city" | "country">> & Omit<CompanyInput, "name" | "legal_name" | "tax_id" | "address" | "city" | "country"> } | { ok: false; error: string } {
  const name = cleanStr(input.name, 200);
  if (!name) return { ok: false, error: "Nombre comercial requerido (máx 200)." };
  const legal_name = cleanStr(input.legal_name, 200);
  if (!legal_name) return { ok: false, error: "Razón social requerida (máx 200)." };
  const tax_id = cleanStr(input.tax_id, 40);
  if (!tax_id) return { ok: false, error: "ID fiscal requerido (máx 40)." };
  const domain = input.domain === undefined || input.domain === null || input.domain === "" ? null : normalizeDomain(input.domain);
  if (input.domain && domain === null) return { ok: false, error: "Web inválida (p. ej. acme.pe)." };
  const email = cleanStr(input.email, 320);
  if (input.email && !email) return { ok: false, error: "Email inválido." };
  if (email && !isValidEmail(email)) return { ok: false, error: "Email inválido." };
  // País: ISO2 real (misma regla que el cliente company-validation:
  // `isCountryCode`). El servidor era más laxo (cualquier 2 letras) y dejaba
  // pasar "AA": ahora espejo exacto, el cliente nunca bloquea un valor válido.
  // Obligatorio (igual que RUC, dirección y ciudad): legados con null lo
  // completan en la próxima edición.
  const countryRaw = cleanStr(input.country, 2)?.toUpperCase() ?? null;
  if (!countryRaw) {
    return { ok: false, error: "País requerido (ISO2, p. ej. PE)." };
  }
  if (!isCountryCode(countryRaw)) {
    return { ok: false, error: "País inválido (ISO2, p. ej. PE)." };
  }
  const country = countryRaw;
  const address = cleanStr(input.address, 300);
  if (!address) return { ok: false, error: "Dirección requerida (máx 300)." };
  const city = cleanStr(input.city, 120);
  if (!city) return { ok: false, error: "Ciudad requerida (máx 120)." };
  const external_ref = cleanStr(input.external_ref, 120);
  if (input.external_ref && !external_ref) return { ok: false, error: "external_ref inválido." };
  const kind = input.kind ?? null;
  if (!isCompanyKind(kind)) return { ok: false, error: "Tipo requerido: agencia, anunciante o proveedor." };
  const categoryRaw = typeof input.category_iab === "string" ? input.category_iab.trim().toUpperCase() : null;
  const category_iab: AdvertiserCategoryCode | null = !categoryRaw ? null : isAdvertiserCategory(categoryRaw) ? categoryRaw : null;
  if (categoryRaw && !category_iab) return { ok: false, error: "Categoría IAB inválida (IAB1–IAB24)." };
  const providerRaw = typeof input.provider_type === "string" ? input.provider_type.trim().toLowerCase() : null;
  const provider_type: ProviderTypeCode | null = !providerRaw ? null : isProviderType(providerRaw) ? providerRaw : null;
  if (providerRaw && !provider_type) return { ok: false, error: "Tipo de proveedor inválido." };
  if (provider_type && kind !== "proveedor") return { ok: false, error: "Tipo de proveedor solo aplica a proveedores." };
  return {
    ok: true,
    value: {
      name,
      legal_name,
      kind,
      category_iab,
      provider_type,
      tax_id,
      domain,
      email,
      phone: cleanStr(input.phone, 40),
      address,
      city,
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
