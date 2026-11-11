"use client";

// Validación cliente para empresas (Nueva + edición): espejo liviano de
// `normalizeCompany`. Sigue el default de forms (ver ui/form-feedback):
// sin validación nativa, error = borde + toast, submit deshabilitado
// hasta completar obligatorios.

export { FIELD_ERR_CLS } from "@/components/ui/form-feedback";
import { isCountryCode } from "@/lib/countries";

// SSOT país: isCountryCode de lib/countries.ts (issue #8 P2). El server
// (normalizeCompany) acepta ISO2 libre; el cliente valida contra la lista.

export type CompanyFieldKey = "name" | "legalName" | "taxId" | "domain" | "address" | "city" | "country" | "commission" | "kind" | "category" | "providerType";

export interface CompanyFieldValues {
  name: string;
  legalName: string;
  taxId: string;
  domain: string;
  address: string;
  city: string;
  country: string;
  commission?: string;
  kind?: string;
  categoryIab?: string;
  providerType?: string;
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
  if (!v.name.trim()) out.push({ key: "name", message: "Nombre comercial requerido." });
  else if (v.name.trim().length > 200) out.push({ key: "name", message: "Nombre comercial muy largo (máx 200)." });
  if (!v.legalName.trim()) out.push({ key: "legalName", message: "Razón social requerida." });
  else if (v.legalName.trim().length > 200) out.push({ key: "legalName", message: "Razón social muy larga (máx 200)." });
  if (!v.taxId.trim()) out.push({ key: "taxId", message: "ID fiscal requerido." });
  else if (v.taxId.trim().length > 40) out.push({ key: "taxId", message: "ID fiscal muy largo (máx 40)." });
  if (!domainOk(v.domain)) out.push({ key: "domain", message: "Web inválida (p. ej. acme.pe)." });
  if (!v.address.trim()) out.push({ key: "address", message: "Dirección requerida." });
  else if (v.address.trim().length > 300) out.push({ key: "address", message: "Dirección muy larga (máx 300)." });
  if (!v.city.trim()) out.push({ key: "city", message: "Ciudad requerida." });
  else if (v.city.trim().length > 120) out.push({ key: "city", message: "Ciudad muy larga (máx 120)." });
  const c = v.country.trim();
  if (!c) out.push({ key: "country", message: "País requerido." });
  else if (!isCountryCode(c)) out.push({ key: "country", message: "País inválido (ISO2, p. ej. PE)." });
  if (v.commission !== undefined) {
    const t = v.commission.trim();
    if (t && (!/^\d+$/.test(t) || Number(t) > 100)) {
      out.push({ key: "commission", message: "Comisión inválida (entero 0-100)." });
    }
  }
  if (v.kind === "anunciante" && !(v.categoryIab ?? "").trim()) {
    out.push({ key: "category", message: "Elige la categoría del anunciante." });
  }
  if (v.kind === "proveedor" && !(v.providerType ?? "").trim()) {
    out.push({ key: "providerType", message: "Elige el tipo de proveedor." });
  }
  return out;
}

/** Mapea un mensaje del server action al campo a resaltar. */
export function fieldsFromMessage(msg: string): CompanyFieldKey[] {
  if (/raz[oó]n social/i.test(msg)) return ["legalName"];
  if (/nombre/i.test(msg)) return ["name"];
  if (/fiscal/i.test(msg)) return ["taxId"];
  if (/direcci[oó]n/i.test(msg)) return ["address"];
  if (/ciudad/i.test(msg)) return ["city"];
  if (/web|dominio/i.test(msg)) return ["domain"];
  if (/país|pais|iso/i.test(msg)) return ["country"];
  if (/comisión|comision/i.test(msg)) return ["commission"];
  if (/tipo de proveedor/i.test(msg)) return ["providerType"];
  if (/categor[ií]a|IAB/i.test(msg)) return ["category"];
  if (/tipo/i.test(msg)) return ["kind"];
  return [];
}
