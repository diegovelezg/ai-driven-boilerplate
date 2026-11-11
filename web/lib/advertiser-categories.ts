// Categoría de anunciante IAB 2.0 (`cat` de OpenRTB, IAB1–IAB24).
// SSOT para selects y validación (como lib/countries.ts): la BD solo valida
// con CHECK. EN = código interoperable pDOOH; ES = etiqueta local (Perú).
// Congelado: no editable por tenant. Tier 2 de IAB 3.x queda para después.

export const ADVERTISER_CATEGORIES = [
  { code: "IAB1", name_en: "Arts & Entertainment", name_es: "Arte y Entretenimiento" },
  { code: "IAB2", name_en: "Automotive", name_es: "Automotriz" },
  { code: "IAB3", name_en: "Business", name_es: "Negocios y Empresas" },
  { code: "IAB4", name_en: "Careers", name_es: "Empleo y Carrera" },
  { code: "IAB5", name_en: "Education", name_es: "Educación" },
  { code: "IAB6", name_en: "Family & Parenting", name_es: "Familia y Crianza" },
  { code: "IAB7", name_en: "Health & Fitness", name_es: "Salud y Bienestar" },
  { code: "IAB8", name_en: "Food & Drink", name_es: "Alimentos y Bebidas" },
  { code: "IAB9", name_en: "Hobbies & Interests", name_es: "Aficiones e Intereses" },
  { code: "IAB10", name_en: "Home & Garden", name_es: "Hogar y Jardín" },
  { code: "IAB11", name_en: "Law, Gov't & Politics", name_es: "Legal, Gobierno y Política" },
  { code: "IAB12", name_en: "News", name_es: "Noticias y Medios" },
  { code: "IAB13", name_en: "Personal Finance", name_es: "Finanzas Personales" },
  { code: "IAB14", name_en: "Society", name_es: "Sociedad" },
  { code: "IAB15", name_en: "Science", name_es: "Ciencia" },
  { code: "IAB16", name_en: "Pets", name_es: "Mascotas" },
  { code: "IAB17", name_en: "Sports", name_es: "Deportes" },
  { code: "IAB18", name_en: "Style & Fashion", name_es: "Estilo y Moda" },
  { code: "IAB19", name_en: "Technology & Computing", name_es: "Tecnología y Cómputo" },
  { code: "IAB20", name_en: "Travel", name_es: "Viajes y Turismo" },
  { code: "IAB21", name_en: "Real Estate", name_es: "Inmobiliaria" },
  { code: "IAB22", name_en: "Shopping", name_es: "Comercio / Retail" },
  { code: "IAB23", name_en: "Religion & Spirituality", name_es: "Religión y Espiritualidad" },
  { code: "IAB24", name_en: "Uncategorized", name_es: "Sin clasificar" },
] as const;

export type AdvertiserCategoryCode = (typeof ADVERTISER_CATEGORIES)[number]["code"];

export interface AdvertiserCategory {
  code: AdvertiserCategoryCode;
  name_en: string;
  name_es: string;
}

const CODES = new Set<string>(ADVERTISER_CATEGORIES.map((c) => c.code));

export function isAdvertiserCategory(v: unknown): v is AdvertiserCategoryCode {
  return typeof v === "string" && CODES.has(v);
}

/** Etiqueta ES para la UI (null si el código no es de la lista). */
export function advertiserCategoryLabel(code: string | null): string | null {
  if (!code) return null;
  return ADVERTISER_CATEGORIES.find((c) => c.code === code)?.name_es ?? null;
}

/** Nombre EN interoperable (OpenRTB `cat`). */
export function advertiserCategoryNameEn(code: string | null): string | null {
  if (!code) return null;
  return ADVERTISER_CATEGORIES.find((c) => c.code === code)?.name_en ?? null;
}
