// Definiciones puras del perfil del tenant + arquetipos de churn.
// Módulo SIN imports server: lo importan Client Components
// (profile-proposals, tenant-profile-form), tests tsx y código servidor.
// Todo lo que toque Supabase vive en `lib/store-profiles.ts` (solo servidor).

export type BusinessModel = "b2c" | "b2b" | "hybrid";
export type CatalogType =
  | "consumible"
  | "perecedero"
  | "moda_estacional"
  | "durable"
  | "servicio"
  | "digital"
  | "mixto";
export type ArchetypeId =
  | "b2c_consumible"
  | "b2c_moda"
  | "b2c_durable"
  | "b2b_recurrente"
  | "b2b_proyecto"
  | "hibrido";

export interface StoreProfile {
  storeId: string;
  businessModel: BusinessModel;
  /** Vertical con las palabras del agente (verdad primaria). */
  verticalDetected: string | null;
  /** Nodo de taxonomía estándar (null = sin mapeo honesto). */
  taxonomyId: string | null;
  /** Granularidad del comprador deducida por el perfilador. */
  buyerType: string | null;
  industry: string | null;
  catalogType: CatalogType | null;
  archetype: ArchetypeId;
  companyRequired: boolean;
  /** Descripción libre del negocio (entrada orgánica primaria). */
  description: string | null;
}

/** Defaults de banda por arquetipo (issue #21 Paso 5): hoy todos reproducen
 *  v2 (0.6/0.15). La forma es global y versionada; los valores son por tenant
 *  con fallback al default del arquetipo (shrinkage, no fitted global). */
export const BAND_CUTS_BY_ARCHETYPE: Record<ArchetypeId, { high: number; low: number }> = {
  b2c_consumible: { high: 0.6, low: 0.15 },
  b2c_moda: { high: 0.6, low: 0.15 },
  b2c_durable: { high: 0.6, low: 0.15 },
  b2b_recurrente: { high: 0.6, low: 0.15 },
  b2b_proyecto: { high: 0.6, low: 0.15 },
  hibrido: { high: 0.6, low: 0.15 },
};

export interface ProfileSignals {
  customers: number;
  companyRate: number;
  customDomainRate: number;
  repeatRate: number;
}

