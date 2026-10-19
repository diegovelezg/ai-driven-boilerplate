// Formato numérico único del sitio.
// Regla: separador de miles ".", separador decimal "," y 0 decimales por defecto.
// Todo valor numérico visible debe pasar por estos helpers (no formatear a mano).

const LOCALE = "es-ES";

type NumberFormatOptions = {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
};

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(LOCALE, {
    useGrouping: true,
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });
  formatters.set(key, created);
  return created;
}

/** 1234567.89 → "1.234.568" (0 decimales por defecto). */
export function formatNumber(
  value: number | null | undefined,
  options: NumberFormatOptions = {},
): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const min = options.minimumFractionDigits ?? 0;
  const max = Math.max(min, options.maximumFractionDigits ?? 0);
  return formatter(min, max).format(n);
}

/** Igual que formatNumber pero siempre con la cantidad de decimales indicada. */
export function formatDecimal(value: number | null | undefined, decimals = 0): string {
  return formatNumber(value, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Ratio 0–1 → "87%" (0 decimales por defecto). */
export function formatPercent(ratio: number | null | undefined, decimals = 0): string {
  if (ratio === null || ratio === undefined) return "—";
  return formatDecimal(ratio * 100, decimals) + "%";
}

/** Porcentaje ya expresado en base 100: 87.4 → "87%". */
export function formatPercentPoints(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return formatDecimal(value, decimals) + "%";
}

/** Símbolos de moneda habituales; el resto cae al código ISO. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  PEN: "S/",
  USD: "US$",
  MXN: "MX$",
  EUR: "€",
  GBP: "£",
  BRL: "R$",
  COP: "COP$",
  CLP: "CLP$",
  ARS: "ARS$",
};

/**
 * Minor units → moneda legible. Conserva el símbolo y aplica el formato único.
 * Ej.: formatMoney(36461777, "PEN") → "S/ 364.618".
 */
export function formatMoney(amountMinor: number, currency: string | null): string {
  const code = (currency ?? "PEN").toUpperCase();
  const amount = Math.round(Number(amountMinor) / 100);
  const symbol = CURRENCY_SYMBOLS[code] ?? code;
  return `${symbol} ${formatNumber(amount)}`;
}
