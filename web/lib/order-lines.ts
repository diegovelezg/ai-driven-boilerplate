// Líneas de la orden (pantallas): validación pura compartida por el form
// (drawer) y el server (`updateOrderLinesAction`). Fechas inclusivas
// "yyyy-mm-dd"; total en mayor (soles/dólares según la orden).
// Testeable con tsx --test, sin BD.
import { isValidISODate } from "@/lib/format";

export interface OrderLineInput {
  screen_id: string;
  starts: string;
  ends: string;
  total: string | number;
  /** Slots reservados (1–100). Ausente/vacío = 1 (default de filas legacy). */
  slots?: string | number | null;
  notes?: string | null;
}

export interface LineProblem {
  /** `lines` (global) o `line-{i}-{screen|starts|ends|total|notes|overlap}`. */
  key: string;
  message: string;
}

function numTotal(v: string | number): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Input crudo del form → slots o null (vacío = 1). Una sola semántica
 *  para tabla, forms y hook de disponibilidad. */
export function parseSlotsInput(v: unknown): number | null {
  const raw = String(v ?? "").trim();
  if (raw === "") return 1;
  return normalizeLineSlots(raw);
}

/** Slots de la línea: entero 1–100. Ausente = 1 (default al agregar pantalla
 *  y de filas legacy); vacío = 1 salvo `blankInvalid` (fail-closed en el
 *  cable: el cliente bloquea el submit, pero un POST directo no debe colar
 *  1 silencioso). null = inválido. */
export function normalizeLineSlots(v: unknown, opts: { blankInvalid?: boolean } = {}): number | null {
  if (v === null || v === undefined) return 1;
  const t = String(v).trim().replace(",", ".");
  if (t === "") return opts.blankInvalid ? null : 1;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) return null;
  return n;
}

/** Valida forma (tipos, fechas, total). La disponibilidad y el tenant los
 *  valida el servidor contra la BD. Vacío = válido. */
export function validateOrderLines(lines: OrderLineInput[]): LineProblem[] {
  const out: LineProblem[] = [];
  if (!Array.isArray(lines) || lines.length === 0) {
    return [{ key: "lines", message: "Agrega al menos una pantalla." }];
  }
  lines.forEach((l, i) => {
    const tag = (f: string) => `line-${i}-${f}`;
    if (!l || typeof l.screen_id !== "string" || !l.screen_id.trim()) {
      out.push({ key: tag("screen"), message: `Línea ${i + 1}: elige pantalla.` });
    }
    const s = typeof l?.starts === "string" ? l.starts.trim() : "";
    const e = typeof l?.ends === "string" ? l.ends.trim() : "";
    if (!isValidISODate(s) || !isValidISODate(e)) {
      out.push({ key: tag("starts"), message: `Línea ${i + 1}: periodo inválido.` });
    } else if (e < s) {
      out.push({ key: tag("ends"), message: `Línea ${i + 1}: fin anterior al inicio.` });
    }
    const t = numTotal(l?.total ?? "");
    if (t === null || t <= 0) {
      out.push({ key: tag("total"), message: `Línea ${i + 1}: total inválido.` });
    }
    if (normalizeLineSlots(l?.slots, { blankInvalid: true }) === null) {
      out.push({ key: tag("slots"), message: `Línea ${i + 1}: slots inválidos (1–100).` });
    }
    const notes = typeof l?.notes === "string" ? l.notes : "";
    if (notes.trim().length > 2000) {
      out.push({ key: tag("notes"), message: `Línea ${i + 1}: nota muy larga (máx 2000).` });
    }
  });
  for (const [a, b] of findLineOverlaps(lines)) {
    out.push({ key: `line-${a}-overlap`, message: `Líneas ${a + 1} y ${b + 1}: misma pantalla con periodos que se cruzan.` });
  }
  return out;
}

/** Pares del mismo screen_id con periodos inclusivos que se cruzan. */
export function findLineOverlaps(lines: OrderLineInput[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      const la = lines[a];
      const lb = lines[b];
      if (!la || !lb) continue;
      const sa = typeof la.starts === "string" ? la.starts.trim() : "";
      const ea = typeof la.ends === "string" ? la.ends.trim() : "";
      const sb = typeof lb.starts === "string" ? lb.starts.trim() : "";
      const eb = typeof lb.ends === "string" ? lb.ends.trim() : "";
      if (!la.screen_id || la.screen_id !== lb.screen_id) continue;
      if (!isValidISODate(sa) || !isValidISODate(ea) || !isValidISODate(sb) || !isValidISODate(eb)) continue;
      if (sa <= eb && sb <= ea) out.push([a, b]);
    }
  }
  return out;
}

/** Total mayor → minor (céntimos) para la BD. */
export function totalToMinor(v: string | number): number | null {
  const n = numTotal(v);
  if (n === null || n <= 0) return null;
  return Math.round(n * 100);
}
