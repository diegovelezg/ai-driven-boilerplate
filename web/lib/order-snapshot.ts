// Snapshot de NP al firmar: foto inmutable de las contrapartes para que el
// documento no pierda datos aunque empresas/contactos se archiven o cambien.
// Puro y testeable (sin BD). El PDF prefiere snapshot cuando existe.
export interface SnapshotContact {
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
}

export interface OrderSnapshot {
  v: 1;
  signed_at: string;
  currency: string;
  payment_terms_days: number | null;
  gross_minor: number;
  advertiser: {
    name: string | null;
  };
  billing: {
    name: string | null;
    tax_id: string | null;
    city: string | null;
    country: string | null;
  };
  agency: {
    name: string | null;
    tax_id: string | null;
    commission_pct: number | null;
  } | null;
  contacts: {
    billing: SnapshotContact | null;
    signer: SnapshotContact | null;
    payment: SnapshotContact | null;
    manager: SnapshotContact | null;
  };
}

export interface SnapshotSourceContact {
  name?: string | null;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
}

function snapContact(c: SnapshotSourceContact | null | undefined): SnapshotContact | null {
  if (!c) return null;
  const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : null;
  if (!name) return null;
  return {
    name,
    role: typeof c.role === "string" && c.role.trim() ? c.role.trim() : null,
    email: typeof c.email === "string" && c.email.trim() ? c.email.trim() : null,
    phone: typeof c.phone === "string" && c.phone.trim() ? c.phone.trim() : null,
  };
}

/** Construye la foto al firmar desde el detalle vivo. Solo tipos base. */
export function buildOrderSnapshot(input: {
  signed_at: string;
  currency: string;
  payment_terms_days: number | null;
  gross_minor: number;
  advertiser_name: string | null;
  billing_name: string | null;
  billing_tax_id: string | null;
  billing_city: string | null;
  billing_country: string | null;
  agency_name: string | null;
  agency_tax_id: string | null;
  agency_commission_pct: number | null;
  billing_contact?: SnapshotSourceContact | null;
  signer_contact?: SnapshotSourceContact | null;
  payment_contact?: SnapshotSourceContact | null;
  manager_contact?: SnapshotSourceContact | null;
}): OrderSnapshot {
  const gross = Number.isFinite(input.gross_minor) && input.gross_minor >= 0 ? Math.round(input.gross_minor) : 0;
  const hasAgency =
    input.agency_name !== null ||
    input.agency_tax_id !== null ||
    input.agency_commission_pct !== null;
  return {
    v: 1,
    signed_at: input.signed_at,
    currency: input.currency,
    payment_terms_days: input.payment_terms_days,
    gross_minor: gross,
    advertiser: {
      name: input.advertiser_name,
    },
    billing: {
      name: input.billing_name,
      tax_id: input.billing_tax_id,
      city: input.billing_city,
      country: input.billing_country,
    },
    agency: hasAgency
      ? {
          name: input.agency_name,
          tax_id: input.agency_tax_id,
          commission_pct: input.agency_commission_pct,
        }
      : null,
    contacts: {
      billing: snapContact(input.billing_contact),
      signer: snapContact(input.signer_contact),
      payment: snapContact(input.payment_contact),
      manager: snapContact(input.manager_contact),
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optStr(r: Record<string, unknown>, k: string): string | null {
  const v = r[k];
  return typeof v === "string" && v.trim() ? v : null;
}

function optNum(r: Record<string, unknown>, k: string): number | null {
  const v = r[k];
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseSnapContact(v: unknown): SnapshotContact | null {
  if (!isRecord(v)) return null;
  const name = optStr(v, "name");
  if (!name) return null;
  return { name, role: optStr(v, "role"), email: optStr(v, "email"), phone: optStr(v, "phone") };
}

/** Parse defensivo para el PDF: null ante cualquier forma inválida. */
export function parseOrderSnapshot(v: unknown): OrderSnapshot | null {
  if (!isRecord(v) || v.v !== 1) return null;
  const billing = isRecord(v.billing) ? v.billing : null;
  const advertiser = isRecord(v.advertiser) ? v.advertiser : null;
  const agencyRaw = v.agency;
  const agency =
    agencyRaw === null || agencyRaw === undefined
      ? null
      : isRecord(agencyRaw)
        ? {
            name: optStr(agencyRaw, "name"),
            tax_id: optStr(agencyRaw, "tax_id"),
            commission_pct: optNum(agencyRaw, "commission_pct"),
          }
        : null;
  if (!billing) return null;
  const contacts = isRecord(v.contacts) ? v.contacts : null;
  if (!contacts) return null;
  const signedAt = typeof v.signed_at === "string" && v.signed_at ? v.signed_at : null;
  if (!signedAt) return null;
  return {
    v: 1,
    signed_at: signedAt,
    currency: typeof v.currency === "string" && v.currency ? v.currency : "PEN",
    payment_terms_days: optNum(v, "payment_terms_days"),
    gross_minor: (() => {
      const n = Number(v.gross_minor);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
    })(),
    billing: {
      name: optStr(billing, "name"),
      tax_id: optStr(billing, "tax_id"),
      city: optStr(billing, "city"),
      country: optStr(billing, "country"),
    },
    advertiser: {
      name: advertiser ? optStr(advertiser, "name") : null,
    },
    agency,
    contacts: {
      billing: parseSnapContact(contacts.billing),
      signer: parseSnapContact(contacts.signer),
      payment: parseSnapContact(contacts.payment),
      manager: parseSnapContact(contacts.manager),
    },
  };
}
