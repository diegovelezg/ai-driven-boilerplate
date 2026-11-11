// Tipo de proveedor DOOH. SSOT para selects y validación
// (como lib/advertiser-categories.ts): la BD solo valida con CHECK.
// No hay estándar internacional (IAB no cubre proveedores); los códigos EN
// siguen el vocabulario de la industria (media owner, print, field ops).
// Solo aplica cuando kind = 'proveedor'. Congelado: no editable por tenant.

export const PROVIDER_TYPES = [
  { code: "media_owner", name_en: "Media Owner", name_es: "Exhibidor" },
  { code: "print_production", name_en: "Print & Production", name_es: "Impresión / Producción" },
  { code: "installation", name_en: "Installation", name_es: "Instalación / Montaje" },
  { code: "maintenance", name_en: "Maintenance", name_es: "Mantenimiento" },
  { code: "other", name_en: "Other", name_es: "Otro" },
] as const;

export type ProviderTypeCode = (typeof PROVIDER_TYPES)[number]["code"];

export interface ProviderType {
  code: ProviderTypeCode;
  name_en: string;
  name_es: string;
}

const CODES = new Set<string>(PROVIDER_TYPES.map((t) => t.code));

export function isProviderType(v: unknown): v is ProviderTypeCode {
  return typeof v === "string" && CODES.has(v);
}

/** Etiqueta ES para la UI (null si el código no es de la lista). */
export function providerTypeLabel(code: string | null): string | null {
  if (!code) return null;
  return PROVIDER_TYPES.find((t) => t.code === code)?.name_es ?? null;
}
