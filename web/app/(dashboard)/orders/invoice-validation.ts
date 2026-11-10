// Validación cliente del form de factura (drawer → cobranza): espejo liviano
// del `createInvoiceAction` de lib/order-flow-actions.ts (misma tolerancia).
// Sigue el default de forms (ver ui/form-feedback): sin validación nativa,
// error = borde + toast, submit deshabilitado hasta completar.
// Módulo puro (sin "use client"): importa FIELD_ERR_CLS directo de
// form-feedback en el form, no desde aquí.
// Fechas: SSOT en lib/format.ts.
import { isValidISODate } from "@/lib/format";

export type InvoiceFieldKey = "number" | "amount" | "issue" | "due" | "status";

export interface InvoiceFieldValues {
  number: string;
  /** Monto en soles (texto libre: "5000", "5,000.50"). */
  amount: string;
  /** "yyyy-mm-dd" o "". */
  issue: string;
  /** "yyyy-mm-dd" o "". */
  due: string;
  status: string;
}

const INVOICE_STATUS_OPTIONS = ["issued", "paid"] as const;

/** "5,000.50" / "5000" → céntimos; null = inválido.
 *  La coma solo vale como separador de miles (1-3 dígitos + grupos de 3):
 *  "5,00,0" se rechaza en vez de colapsar a 5000. */
export function parseAmountToMinor(raw: string): number | null {
  const t = String(raw ?? "").trim().replace(/\s/g, "");
  if (!t) return null;
  if (t.includes(",")) {
    // Miles estrictos + opcional .dd  — rechaza "5,00,0" y "5.000,50".
    if (!/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t) && !/^\d{1,3}(,\d{3})+$/.test(t)) return null;
  }
  const flat = t.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(flat)) return null;
  const n = Number(flat);
  if (!Number.isFinite(n) || n <= 0 || n > 999_999_999.99) return null;
  const minor = Math.round(n * 100);
  if (minor < 1) return null;
  return minor;
}

function isRealDate(v: string): boolean {
  return isValidISODate(v);
}

/** Devuelve la lista de campos inválidos con su mensaje (vacío = válido). */
export function validateInvoiceFields(v: InvoiceFieldValues): Array<{ key: InvoiceFieldKey; message: string }> {
  const out: Array<{ key: InvoiceFieldKey; message: string }> = [];
  const num = v.number.trim();
  if (!num) out.push({ key: "number", message: "Número de factura requerido (ej F001-123)." });
  else if (num.length > 60) out.push({ key: "number", message: "Número muy largo (máx 60)." });
  if (parseAmountToMinor(v.amount) === null) {
    out.push({ key: "amount", message: "Monto inválido: número > 0, máx 2 decimales." });
  }
  if (v.issue && !isRealDate(v.issue)) out.push({ key: "issue", message: "Emisión inválida (aaaa-mm-dd)." });
  if (v.due && !isRealDate(v.due)) out.push({ key: "due", message: "Vencimiento inválido (aaaa-mm-dd)." });
  if (v.issue && v.due && isRealDate(v.issue) && isRealDate(v.due) && v.due < v.issue) {
    out.push({ key: "due", message: "Vence antes de la emisión." });
  }
  if (!(INVOICE_STATUS_OPTIONS as readonly string[]).includes(v.status)) {
    out.push({ key: "status", message: "Estado inicial inválido (emitida o pagada)." });
  }
  return out;
}

/** Mapea un mensaje del server action al campo a resaltar. */
export function invoiceFieldsFromMessage(msg: string): InvoiceFieldKey[] {
  if (/número|numero|existe/i.test(msg)) return ["number"];
  if (/monto/i.test(msg)) return ["amount"];
  // `vence` antes que `emisión`: "Vence antes de la emisión" es error de due.
  if (/vence|vencimiento/i.test(msg)) return ["due"];
  if (/emisión|emision/i.test(msg)) return ["issue"];
  if (/estado/i.test(msg)) return ["status"];
  if (/cancelada/i.test(msg)) return [];
  return [];
}

export interface InvoiceBilling {
  name: string | null;
  taxId: string | null;
}

/** Bloqueante de facturación: sin razón social o sin RUC no se puede emitir.
 *  Devuelve el motivo (para mostrar y titular el submit) o null si está lista. */
export function billingBlocker(b: InvoiceBilling): string | null {
  if (!b.name?.trim()) return "Sin empresa de facturación: fíjala en la ficha de la orden.";
  if (!b.taxId?.trim()) return "Sin RUC: complétalo en la ficha de la empresa.";
  return null;
}
