// SSOT: IVA/IGV por país del tenant (ISO2).
// El tenant es single-país: `sys_stores.shop_country` manda.
// El valor que viaja en BD sigue siendo minor units SIN impuesto;
// esto solo parametriza la tasa y el nombre visible (IGV vs IVA/ITBIS/...).
// Patrón gemelo a `lib/tax-id.ts` (TAX_ID_LABELS).

/** Tasa general del impuesto al valor agregado por país (tanto por uno). */
export const VAT_RATES: Record<string, number> = {
  AR: 0.21,
  BO: 0.13,
  // BR: reforma tributaria en transición (IBS+CBS ~28% estimado 2026).
  // Provisional: revisar cuando el tenant opere en BR.
  BR: 0.28,
  CL: 0.19,
  CO: 0.19,
  CR: 0.13,
  DO: 0.18,
  EC: 0.15,
  ES: 0.21,
  GT: 0.12,
  HN: 0.15,
  MX: 0.16,
  NI: 0.15,
  PA: 0.07,
  PE: 0.18,
  SV: 0.13,
  // US: sin IVA federal (sales tax varía por estado). 0 = sin impuesto.
  US: 0,
  UY: 0.22,
  VE: 0.16,
};

/** Nombre local del impuesto por país (para labels/NP/PDF). */
export const TAX_NAMES: Record<string, string> = {
  PE: "IGV",
  DO: "ITBIS",
  PA: "ITBMS",
  HN: "ISV",
};

/** Tasa fallback cuando el tenant no tiene país (legacy: tenant PE). */
export const DEFAULT_TAX_RATE = 0.18;

/** Nombre fallback del impuesto (legacy: tenant PE). */
export const DEFAULT_TAX_NAME = "IGV";

function normCountry(country: unknown): string {
  return typeof country === "string" ? country.trim().toUpperCase() : "";
}

/** Tasa del impuesto para un país ISO2 (o el default si no mapea). */
export function vatRateForCountry(country: unknown): number {
  const code = normCountry(country);
  if (!code) return DEFAULT_TAX_RATE;
  return VAT_RATES[code] ?? DEFAULT_TAX_RATE;
}

/** Nombre del impuesto para un país ISO2 (o el genérico/fallback). */
export function taxNameForCountry(country: unknown): string {
  const code = normCountry(country);
  if (code && TAX_NAMES[code]) return TAX_NAMES[code];
  if (code && VAT_RATES[code] !== undefined) return "IVA";
  if (!code) return DEFAULT_TAX_NAME;
  return "IVA";
}

/** Desglose de un bruto SIN impuesto en minor units para un país dado.
 *  Redondeo half-up al céntimo en el impuesto (`Math.round`),
 *  total = neto + impuesto exacto. */
export function splitTax(
  grossMinor: number,
  country?: unknown,
): { net: number; tax: number; total: number; rate: number; name: string } {
  const net = Number.isFinite(grossMinor) ? Math.max(0, Math.round(grossMinor)) : 0;
  const rate = vatRateForCountry(country);
  const tax = Math.round(net * rate);
  return { net, tax, total: net + tax, rate, name: taxNameForCountry(country) };
}
