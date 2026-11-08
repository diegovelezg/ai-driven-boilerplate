// Comisión de agencia: pura (testeable con tsx --test, sin BD).
// Acuerdo a nivel empresa + override a nivel IO, % sobre bruto, neto a agencia.
//   bruto = suma io_lines.rate_minor
//   commission = round(bruto * pct / 100); neto = bruto - commission

export function normalizeCommissionPct(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

/** Override IO > default empresa > 0. Marca directa (sin agencia) resuelve 0. */
export function resolveCommissionPct(
  ioOverride: number | null | undefined,
  companyDefault: number | null | undefined,
): number {
  const o = normalizeCommissionPct(ioOverride);
  if (o !== null) return o;
  const d = normalizeCommissionPct(companyDefault);
  if (d !== null) return d;
  return 0;
}

/** true cuando hay intermediario: anunciante != razón a facturar. */
export function isAgencyDeal(
  advertiserId: string | null | undefined,
  billingId: string | null | undefined,
): boolean {
  if (!advertiserId || !billingId) return false;
  return advertiserId !== billingId;
}

export interface AgencySplit {
  grossMinor: number;
  commissionPct: number;
  commissionMinor: number;
  netMinor: number;
}

export function splitAgencyAmounts(grossMinor: number, pct: number): AgencySplit {
  if (!Number.isInteger(grossMinor) || grossMinor < 0) {
    throw new Error("bruto inválido (entero >= 0).");
  }
  const p = normalizeCommissionPct(pct);
  if (p === null) throw new Error("comisión inválida (entero 0-100).");
  const commissionMinor = Math.round((grossMinor * p) / 100);
  return { grossMinor, commissionPct: p, commissionMinor, netMinor: grossMinor - commissionMinor };
}
