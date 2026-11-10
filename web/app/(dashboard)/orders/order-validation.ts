"use client";

// Validación cliente para edición de orden (drawer): espejo liviano del
// `updateOrderAction` de lib/order-actions.ts (misma tolerancia: marca y
// notas opcionales con tope, condición de pago entera ≥ 0; campos NP de
// contacto/firma opcionales con topes + email válido).
// Sigue el default de forms (ver ui/form-feedback): sin validación nativa,
// error = borde + toast, submit deshabilitado hasta completar.

import { normalizeCommissionPct } from "@/lib/agency-commission";

export type OrderFieldKey =
  | "brand"
  | "terms"
  | "notes"
  | "billing_portal_email"
  | "billing_detail"
  | "invoice_registration"
  | "doc_orden_medios"
  | "doc_orden_compra"
  | "doc_contrato"
  | "agency_company_id"
  | "commission_pct"
  | "billing_contact_id"
  | "signer_contact_id"
  | "payment_contact_id"
  | "manager_contact_id";

export interface OrderFieldValues {
  brand: string;
  /** Vacío = sin definir; si no, días como texto ("0" = Contado). */
  terms: string;
  notes: string;
  billing_portal_email: string;
  billing_detail: string;
  invoice_registration: string;
  doc_orden_medios: boolean;
  doc_orden_compra: boolean;
  doc_contrato: boolean;
  agency_company_id: string;
  /** "" = sin override (hereda); si no, entero 0-100 como texto. */
  commission_pct: string;
  billing_contact_id: string;
  signer_contact_id: string;
  payment_contact_id: string;
  manager_contact_id: string;
}

/** Atajos del Select de condición de pago (no es whitelist: el servidor
 *  acepta cualquier entero ≥ 0; valores fuera de la lista se muestran tal cual). */
export const ORDER_TERMS_OPTIONS = ["0", "30", "60", "90"] as const;

function tooLong(v: string, max: number): boolean {
  return v.trim().length > max;
}

/** Devuelve la lista de campos inválidos con su mensaje (vacío = válido). */
export function validateOrderFields(v: OrderFieldValues): Array<{ key: OrderFieldKey; message: string }> {
  const out: Array<{ key: OrderFieldKey; message: string }> = [];
  if (v.brand.trim().length > 200) out.push({ key: "brand", message: "Marca muy larga (máx 200)." });
  // Espejo del servidor (`updateOrderAction`): vacío = sin definir; si no,
  // entero ≥ 0 (el servidor acepta 15, 45, etc.: la lista corta del Select
  // es atajo, no límite).
  const t = v.terms.trim();
  if (t !== "" && !/^\d+$/.test(t)) {
    out.push({ key: "terms", message: "Condición de pago inválida (entero ≥ 0)." });
  }
  if (v.notes.trim().length > 2000) out.push({ key: "notes", message: "Notas muy largas (máx 2000)." });
  // Ficha NP (nota de pedido): todo opcional; topes espejo del servidor.
  // Sección III (condiciones de facturación): texto libre con topes.
  // Portal acepta "Empresa | correo" (ver NP de referencia), no es email puro.
  if (tooLong(v.billing_portal_email, 320)) out.push({ key: "billing_portal_email", message: "Correo y/o portal muy largo (máx 320)." });
  if (tooLong(v.billing_detail, 500)) out.push({ key: "billing_detail", message: "Detalle de facturación muy largo (máx 500)." });
  if (tooLong(v.invoice_registration, 500)) out.push({ key: "invoice_registration", message: "Registro de factura muy largo (máx 500)." });
  // Opción B: override de comisión por orden (vacío = hereda). Solo enteros.
  const cp = v.commission_pct.trim();
  if (cp !== "" && normalizeCommissionPct(cp) === null) {
    out.push({ key: "commission_pct", message: "Comisión inválida (entero 0-100)." });
  }
  return out;
}

/** Mapea un mensaje del server action al campo a resaltar. */
export function fieldsFromMessage(msg: string): OrderFieldKey[] {
  if (/\(POC\)/i.test(msg)) return ["billing_contact_id"];
  if (/\(firmante\)/i.test(msg)) return ["signer_contact_id"];
  if (/\(pago\)/i.test(msg)) return ["payment_contact_id"];
  if (/\(responsable\)/i.test(msg)) return ["manager_contact_id"];
  if (/intermediaria/i.test(msg)) return ["agency_company_id"];
  if (/comisión|comision/i.test(msg)) return ["commission_pct"];
  if (/documento/i.test(msg)) return ["doc_orden_medios", "doc_orden_compra", "doc_contrato"];
  if (/detalle de facturación|detalle de facturacion/i.test(msg)) return ["billing_detail"];
  if (/registro/i.test(msg)) return ["invoice_registration"];
  if (/portal/i.test(msg)) return ["billing_portal_email"];
  if (/marca/i.test(msg)) return ["brand"];
  if (/condición|condicion/i.test(msg)) return ["terms"];
  if (/nota/i.test(msg)) return ["notes"];
  if (/cancelada/i.test(msg)) return [];
  return [];
}
