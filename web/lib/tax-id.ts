// SSOT: nombre del ID fiscal (TIN) de empresas por país (ISO2).
// El valor que viaja en BD/API sigue siendo `tax_id` (código neutro);
// esto solo etiqueta lo visible (forms, tablas, mensajes, PDF).

export const TAX_ID_LABELS: Record<string, string> = {
  AR: "CUIT",
  BO: "NIT",
  BR: "CNPJ",
  CL: "RUT",
  CO: "NIT",
  CR: "NITE",
  DO: "RNC",
  EC: "RUC",
  ES: "NIF",
  GT: "NIT",
  HN: "RTN",
  MX: "RFC",
  NI: "RUC",
  PA: "RUC",
  PE: "RUC",
  SV: "NIT",
  US: "EIN",
  UY: "RUT",
  VE: "RIF",
};

/** Etiqueta genérica cuando el país no mapea (o no se conoce). */
export const DEFAULT_TAX_ID_LABEL = "ID fiscal";

/** Etiqueta del ID fiscal para un país ISO2 (o la genérica si no aplica). */
export function taxIdLabel(country: unknown): string {
  const code = typeof country === "string" ? country.trim().toUpperCase() : "";
  return (code && TAX_ID_LABELS[code]) || DEFAULT_TAX_ID_LABEL;
}
