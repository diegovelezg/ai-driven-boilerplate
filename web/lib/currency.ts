// SSOT de moneda (issue #6): un solo normalizador + validación para todo DOOH.
// Reglas: ISO3 mayúsculas, rechaza códigos no monetarios (XXX/ZZZ/XTS) y vacíos.
const NON_MONEY = new Set(["XXX", "ZZZ", "XTS", "XAU", "XAG", "XDR"]);

export function normalizeCurrency(raw: unknown, fallback = "PEN"): string {
  const v = String(raw ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(v) && !NON_MONEY.has(v)) return v;
  return fallback;
}

export function isValidCurrency(raw: unknown): boolean {
  const v = String(raw ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) && !NON_MONEY.has(v);
}

/** ¿La factura pertenece a la moneda de la IO? null/vacío NO hereda: se excluye. */
export function invoiceMatchesOrder(invoiceCurrency: unknown, orderCurrency: string): boolean {
  const c = String(invoiceCurrency ?? "").trim().toUpperCase();
  if (!c) return false;
  return c === orderCurrency.toUpperCase();
}
