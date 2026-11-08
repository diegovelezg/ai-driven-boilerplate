// Formato numérico único del sitio (SSOT).
// Regla: separador de miles ".", separador decimal "," y 0 decimales por defecto.
// Todo valor numérico visible debe pasar por estos helpers (no formatear a mano).
//
// Unidades: los montos de la DB/API viajan en MINOR units (céntimos) y
// `formatMoney` divide ÷100. Nunca pasar soles/pesos ya divididos.
// Ratio vs puntos: `formatPercent` recibe ratio 0–1, `formatPercentPoints`
// recibe 0–100. No intercambiar.

import { normalizeCurrency } from "@/lib/currency";

/** Locale de formateo. `es-ES` ≡ `es-PE` en agrupación/decimal ("."/","); se
 *  fija `es-ES` por disponibilidad garantizada en ICU de Node. Los símbolos de
 *  moneda son manuales (ver CURRENCY_SYMBOLS), no `Intl.Currency`. */
export const FORMAT_LOCALE = "es-ES";

type NumberFormatOptions = {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
};

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(FORMAT_LOCALE, {
    useGrouping: true,
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });
  formatters.set(key, created);
  return created;
}

/** 1234567.89 → "1.234.568" (0 decimales por defecto). */
export function formatNumber(
  value: number | string | null | undefined,
  options: NumberFormatOptions = {},
): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const min = Math.max(0, Math.floor(options.minimumFractionDigits ?? 0));
  const max = Math.max(min, Math.floor(options.maximumFractionDigits ?? 0));
  return formatter(min, max).format(n);
}

/** Igual que formatNumber pero siempre con la cantidad de decimales indicada. */
export function formatDecimal(value: number | string | null | undefined, decimals = 0): string {
  const d = Math.max(0, Math.floor(decimals));
  return formatNumber(value, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

/** Ratio 0–1 → "87%" (0 decimales por defecto). No-finito → "—" (sin "%"). */
export function formatPercent(ratio: number | string | null | undefined, decimals = 0): string {
  if (ratio === null || ratio === undefined) return "—";
  const n = Number(ratio);
  if (!Number.isFinite(n)) return "—";
  const out = formatDecimal(n * 100, decimals);
  return out === "—" ? "—" : `${out}%`;
}

/** Porcentaje ya expresado en base 100: 87.4 → "87%". */
export function formatPercentPoints(
  value: number | string | null | undefined,
  decimals = 0,
): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const out = formatDecimal(value, decimals);
  return out === "—" ? "—" : `${out}%`;
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
 * Ej. con céntimos: formatMoney(1999, "PEN", 2) → "S/ 19,99".
 * Monto no-finito/null → "—" (sin símbolo). Moneda null/vacía → PEN (default
 * histórico de la tienda); desconocida → código ISO.
 */
export function formatMoney(
  amountMinor: number | string | null | undefined,
  currency: string | null | undefined,
  decimals = 0,
): string {
  if (amountMinor === null || amountMinor === undefined) return "—";
  const minor = Number(amountMinor);
  if (!Number.isFinite(minor)) return "—";
  const code = normalizeCurrency(currency, "PEN");
  const symbol = CURRENCY_SYMBOLS[code] ?? code;
  const d = Math.max(0, Math.floor(decimals));
  const major = minor / 100;
  const body =
    d === 0 ? formatNumber(Math.round(major)) : formatDecimal(major, d);
  if (body === "—") return "—";
  return `${symbol} ${body}`;
}

/** Etiqueta de condición de pago desde días (fuente numérica).
 *  0 → "Contado", N → "N días", null → "—". El cálculo (vencimientos)
 *  usa el entero; el texto es solo display. */
export function paymentTermsLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return "—";
  return days === 0 ? "Contado" : `${formatNumber(days)} días`;
}

/** Siglas que se conservan en mayúsculas en `toTitleCase` (con o sin puntos). */
const TITLE_ACRONYMS = new Set(["SAC", "SA", "SRL", "EIRL", "SAA", "ID", "DNI"]);

/** Palabras que van en minúscula salvo al inicio (títulos en español). */
const TITLE_MINORS = new Set(["de", "del", "la", "el", "los", "las", "y", "e", "en", "con", "por", "para", "al", "a"]);

/**
 * Nombre propio en Title Case para presentar razones sociales.
 * "ESPECIALIDADES DIGITALES INTERNACIONALES S.A.C" →
 * "Especialidades Digitales Internacionales S.A.C".
 * Respeta siglas (S.A.C., SAC, ID) y minúsculas españolas (de, la, y…).
 * Solo presentación: en BD se guarda el nombre tal cual figura en el ID fiscal.
 */
export function toTitleCase(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const words = value.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (words.length === 0) return "—";
  return words
    .map((w, i) => {
      const bare = w.replace(/\./g, "").toUpperCase();
      if (TITLE_ACRONYMS.has(bare)) {
        // Con puntos se respeta la forma original (S.A.C.); sin puntos, upper.
        return w.includes(".") ? w.toUpperCase() : bare;
      }
      const lower = w.toLowerCase();
      if (i > 0 && TITLE_MINORS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** Tiempo relativo corto (es) para feeds: "ahora mismo" · "hace N min/h" ·
 *  "hace N d" · "dd/mm". Inválido o futuro → "—" / "ahora mismo". */
export function formatTimeAgo(iso: string | null | undefined, nowMs = Date.now()): string {
  if (typeof iso !== "string" || !iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const min = Math.floor(Math.max(0, nowMs - t) / 60_000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `hace ${d} d`;
  const dt = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}`;
}

/** Día/mes corto para vigencias ("2026-11-08" → "08/11"). Inválido → "—". */
export function formatDayMonth(iso: string | null | undefined): string {
  if (typeof iso !== "string") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}` : "—";
}
