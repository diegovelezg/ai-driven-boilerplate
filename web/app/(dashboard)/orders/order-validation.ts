"use client";

// Validación cliente para edición de orden (drawer): espejo liviano del
// `updateOrderAction` de lib/order-actions.ts (misma tolerancia: marca y
// notas opcionales con tope, condición de pago entera ≥ 0).
// Sigue el default de forms (ver ui/form-feedback): sin validación nativa,
// error = borde + toast, submit deshabilitado hasta completar.

export { FIELD_ERR_CLS } from "@/components/ui/form-feedback";

export type OrderFieldKey = "brand" | "terms" | "notes";

export interface OrderFieldValues {
  brand: string;
  /** "__none" = sin definir; si no, días como texto ("0" = Contado). */
  terms: string;
  notes: string;
}

/** Atajos del Select de condición de pago (no es whitelist: el servidor
 *  acepta cualquier entero ≥ 0; valores fuera de la lista se muestran tal cual). */
export const ORDER_TERMS_OPTIONS = ["__none", "0", "30", "60", "90"] as const;

/** Devuelve la lista de campos inválidos con su mensaje (vacío = válido). */
export function validateOrderFields(v: OrderFieldValues): Array<{ key: OrderFieldKey; message: string }> {
  const out: Array<{ key: OrderFieldKey; message: string }> = [];
  if (v.brand.trim().length > 200) out.push({ key: "brand", message: "Marca muy larga (máx 200)." });
  // Espejo exacto del servidor (`updateOrderAction`): "__none"/vacío = sin
  // definir; si no, entero ≥ 0 (el servidor acepta 15, 45, etc.: la lista
  // corta del Select es atajo, no límite).
  const t = v.terms.trim();
  if (t !== "__none" && t !== "" && !/^\d+$/.test(t)) {
    out.push({ key: "terms", message: "Condición de pago inválida (entero ≥ 0)." });
  }
  if (v.notes.trim().length > 2000) out.push({ key: "notes", message: "Notas muy largas (máx 2000)." });
  return out;
}

/** Mapea un mensaje del server action al campo a resaltar. */
export function fieldsFromMessage(msg: string): OrderFieldKey[] {
  if (/marca/i.test(msg)) return ["brand"];
  if (/condición|condicion|pago/i.test(msg)) return ["terms"];
  if (/nota/i.test(msg)) return ["notes"];
  if (/cancelada/i.test(msg)) return [];
  return [];
}
