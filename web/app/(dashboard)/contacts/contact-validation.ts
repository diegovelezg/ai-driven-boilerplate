"use client";

// Validación cliente para contactos (drawer + página Nuevo): espejo liviano
// del server (`crm.ts` exige email o teléfono). Sigue el default de forms:
// sin validación nativa, error = borde + toast, submit deshabilitado.
export { FIELD_ERR_CLS } from "@/components/ui/form-feedback";
import { isValidEmail } from "@/lib/validation";

export type ContactFieldKey = "email" | "phone";

export interface ContactFieldValues {
  email: string;
  phone: string;
}

/** Lista de campos inválidos con mensaje (vacío = válido). */
export function validateContactFields(v: ContactFieldValues): Array<{ key: ContactFieldKey; message: string }> {
  const out: Array<{ key: ContactFieldKey; message: string }> = [];
  const email = v.email.trim();
  const phone = v.phone.trim();
  if (!email && !phone) {
    out.push({ key: "email", message: "Email o teléfono requerido." });
    out.push({ key: "phone", message: "Email o teléfono requerido." });
    return out;
  }
  if (email && !isValidEmail(email)) out.push({ key: "email", message: "Email inválido." });
  return out;
}
