// CSV simple (RFC4180, separador coma): escape por comillas dobles,
// salto CRLF y BOM (U+FEFF) para que Excel abra UTF-8 directo.
// Los montos viajan en mayor con 2 decimales + columna moneda (nunca mixto).
// Anti formula-injection (OWASP): celdas que empiezan con = + - @ (tras
// espacios/BOM) se prefijan con `'` antes del escape RFC4180.
export type CsvCell = string | number | boolean | null | undefined;

function escapeCell(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  // Booleanos "sí"/"no" (display ES): NO aptos para parseo máquina.
  // Quien necesite round-trip debe mapear a true/false en su columna.
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    // Montos ya vienen formateados a string con 2 decimales desde el caller;
    // aquí los números crudos (conteos) van sin comillas si son enteros.
    return Number.isInteger(v) ? String(v) : `"${String(v).replace(/"/g, '""')}"`;
  }
  let s = String(v);
  // OWASP CSV Injection: =, +, -, @, Tab, CR al inicio (ignorando
  // espacios/BOM iniciales que Excel recorta) ejecutan fórmula al abrir.
  const lead = s.replace(/^[\s\uFEFF]+/, "");
  if (/^[=+\-@\t\r]/.test(lead)) s = `'${s}`;
  // RFC4180: comillas si hay coma, comilla, \r o \n.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Filas → texto CSV (sin BOM; el BOM lo pone la respuesta HTTP). */
export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers.map(escapeCell).join(",")];
  for (const r of rows) lines.push(r.map(escapeCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Mayor con 2 decimales desde minor units (céntimos ÷100). */
export function minorToMajor(minor: number | null | undefined): string {
  const n = Number(minor ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  return (Math.round(n) / 100).toFixed(2);
}
