// SSOT de ordenamientos por alias i18n (issue #8 P2).
// COMPANIES/Screens/Brands parseaban ?sort= con mapas copiados (es/en).
// Tablas centralizadas + resolvedor genérico; cada *-db lo importa y
// re-exporta su parse para compat (ninguna ruta importa el mapa directo).
import type { CompaniesSortKey } from "@/lib/crm-db";
import type { ScreensSortKey } from "@/lib/screens-db";
import type { BrandsSortKey } from "@/lib/brand-db";

export const COMPANIES_SORT_ALIASES: Record<string, CompaniesSortKey> = {
  name: "name",
  nombre: "name",
  type: "type",
  tipo: "type",
  contacts: "contacts",
  contactos: "contacts",
  tax_id: "tax_id",
};

export const SCREENS_SORT_ALIASES: Record<string, ScreensSortKey> = {
  name: "name",
  nombre: "name",
  supplier: "supplier",
  proveedor: "supplier",
  city: "city",
  ciudad: "city",
  impact: "impact",
  impacto: "impact",
  price: "price",
  precio: "price",
};

export const BRANDS_SORT_ALIASES: Record<string, BrandsSortKey> = {
  brand: "brand",
  marca: "brand",
  ios: "ios",
  investment: "investment",
  inversion: "investment",
  last: "last",
  ultima: "last",
  screens: "screens",
  pantallas: "screens",
  agencies: "agencies",
  agencias: "agencies",
};

/** Resuelve ?sort= contra un mapa de alias; fallback si no calza. */
export function resolveSortAlias<T extends string>(
  aliases: Record<string, T>,
  raw: string | undefined,
  fallback: T,
): T {
  if (!raw) return fallback;
  return aliases[raw] ?? fallback;
}
