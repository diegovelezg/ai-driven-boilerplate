"use client";

// Validación cliente para empresas (Nueva + edición): espejo liviano de
// `normalizeCompany`. Sigue el default de forms (ver ui/form-feedback):
// sin validación nativa, error = borde + toast, submit deshabilitado
// hasta completar obligatorios.

export { FIELD_ERR_CLS } from "@/components/ui/form-feedback";

export type CompanyFieldKey = "name" | "domain" | "country" | "commission" | "kind";

export interface CompanyFieldValues {
  name: string;
  domain: string;
  country: string;
  commission?: string;
}

function domainOk(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (!v) return true;
  const d = v
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  return d.includes(".") && d.length <= 253;
}

/** Devuelve la lista de campos inválidos con su mensaje (vacío = válido). */
export function validateCompanyFields(v: CompanyFieldValues): Array<{ key: CompanyFieldKey; message: string }> {
  const out: Array<{ key: CompanyFieldKey; message: string }> = [];
  if (!v.name.trim()) out.push({ key: "name", message: "Nombre de empresa requerido." });
  else if (v.name.trim().length > 200) out.push({ key: "name", message: "Nombre muy largo (máx 200)." });
  if (!domainOk(v.domain)) out.push({ key: "domain", message: "Web inválida (p. ej. acme.pe)." });
  const c = v.country.trim();
  if (c && !/^[A-Za-z]{2}$/.test(c)) out.push({ key: "country", message: "País inválido (ISO2, p. ej. PE)." });
  if (v.commission !== undefined) {
    const t = v.commission.trim();
    if (t && (!/^\d+$/.test(t) || Number(t) > 100)) {
      out.push({ key: "commission", message: "Comisión inválida (entero 0-100)." });
    }
  }
  return out;
}

/** Mapea un mensaje del server action al campo a resaltar. */
export function fieldsFromMessage(msg: string): CompanyFieldKey[] {
  if (/nombre/i.test(msg)) return ["name"];
  if (/web|dominio/i.test(msg)) return ["domain"];
  if (/país|pais|iso/i.test(msg)) return ["country"];
  if (/comisión|comision/i.test(msg)) return ["commission"];
  if (/tipo/i.test(msg)) return ["kind"];
  return [];
}
