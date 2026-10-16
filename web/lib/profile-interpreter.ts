// Intérprete local de la descripción libre del negocio (client-safe: sin imports server).
// Hoy: scoring por keywords ES/EN, determinista y offline.
// Mañana: cambiar esta función por una llamada LLM manteniendo el mismo contrato.

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

export interface DescriptionInterpretation {
  businessModel: BusinessModel | null;
  /** Vertical con las palabras del agente/investigación (verdad primaria). */
  vertical: string | null;
  /** Quién compra, en granularidad del perfilador (puede ser null). */
  buyerType: string | null;
  /** true = el merchant dijo que el ciclo varía/no sabe (null respondido, no hueco). */
  cycleUnknown: boolean;
  industry: string | null;
  catalogType: CatalogType | null;
  archetype: ArchetypeId | null;
  cycleDays: number | null;
  companyRequired: boolean;
  confidence: "alta" | "media" | "baja";
  /** Lo que creímos entender (para mostrar al merchant). */
  understood: string[];
  /** Lo que falta por aclarar (máx 3). */
  questions: string[];
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function hits(text: string, words: string[]): number {
  let n = 0;
  for (const w of words) {
    const re = new RegExp(`(^|[^a-z])${w}([^a-z]|$)`);
    if (re.test(text)) n += 1;
  }
  return n;
}

const B2B_WORDS = [
  "empresas", "empresa", "corporativo", "corporativos", "oficinas", "oficina",
  "distribuidora", "distribuidor", "distribuidores", "mayorista", "mayoristas",
  "mayoreo", "por mayor", "b2b", "negocios", "companias", "compania",
  "factura", "facturacion", "cotizacion", "cotizaciones", "ruc",
  "clientes empresa", "restaurantes", "hoteles", "colegios", "clinicas",
];
const B2C_WORDS = [
  "personas", "consumidores", "consumidor", "familias", "familia", "hogares",
  "publico general", "cliente final", "clientes finales", "b2c", "al detalle",
  "tienda online", "retail",
];
const HYBRID_WORDS = ["ambos", "tanto ", "personas y empresas", "empresas y personas", "b2c y b2b", "b2b y b2c"];

const INDUSTRIES: Array<{ id: string; words: string[] }> = [
  { id: "alimentos", words: ["cafe", "cafes", "coffee", "alimentos", "comida", "restaurante", "panaderia", "pasteleria", "chocolate", "miel", "especias", "tostaduria"] },
  { id: "moda", words: ["ropa", "moda", "vestidos", "camisas", "pantalones", "zapatos", "zapatillas", "calzado", "fashion", "streetwear", "denim"] },
  { id: "belleza", words: ["cosmetica", "belleza", "skincare", "maquillaje", "perfume", "perfumes", "serum", "cremas"] },
  { id: "hogar", words: ["muebles", "hogar", "decoracion", "mueble", "sofa", "sillas", "mesas", "iluminacion"] },
  { id: "electronica", words: ["electronica", "tecnologia", "celulares", "laptops", "computadoras", "audio", "gadgets", "smart"] },
  { id: "salud", words: ["salud", "farmacia", "suplementos", "vitaminas", "proteina", "bienestar", "fitness"] },
  { id: "mascotas", words: ["mascotas", "pet", "perros", "gatos", "veterinaria", "croquetas", "peluqueria canina"] },
  { id: "servicios", words: ["servicios", "consultoria", "agencia", "marketing", "diseno", "instalacion", "mantenimiento", "reparacion", "taller", "fotografia"] },
  { id: "distribucion", words: ["distribucion", "distribuidora", "mayorista", "importadora", "abastecimiento", "reparto"] },
];

const CATALOGS: Array<{ id: CatalogType; words: string[] }> = [
  { id: "consumible", words: ["consumible", "recompra", "reposicion", "recurrente", "suscripcion", "mensual", "uso diario", "desechable", "reabastecer"] },
  { id: "perecedero", words: ["perecedero", "perecederos", "fresco", "frescos", "refrigerado", "caduca", "caducidad", "cosecha"] },
  { id: "moda_estacional", words: ["temporada", "coleccion", "colecciones", "moda", "tendencia", "primavera", "verano", "invierno", "otono"] },
  { id: "durable", words: ["durable", "ticket alto", "garantia", "muebles", "electrodomesticos", "inversion", "dura anos", "una sola vez"] },
  { id: "servicio", words: ["servicio", "servicios", "proyecto", "proyectos", "consultoria", "instalacion", "mantenimiento", "cotizacion", "presupuesto"] },
  // Ojo: "online" no está aquí a propósito — suele ser canal de venta ("tienda online"), no producto digital.
  { id: "digital", words: ["digital", "descarga", "descargable", "ebook", "curso", "cursos", "software", "licencia", "plantilla"] },
];

function parseCycleDays(text: string): number | null {
  const m = text.match(/cada\s+(\d+)\s*(dia|dias|semana|semanas|mes|meses|ano|anos)/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    if (unit.startsWith("dia")) return n;
    if (unit.startsWith("semana")) return n * 7;
    if (unit.startsWith("mes")) return n * 30;
    return n * 365;
  }
  if (/\bsemanal\b/.test(text)) return 7;
  if (/\bquincenal\b/.test(text)) return 15;
  if (/\bmensual\b/.test(text)) return 30;
  if (/\bbimestral\b/.test(text)) return 60;
  if (/\btrimestral\b/.test(text)) return 90;
  if (/\bsemestral\b/.test(text)) return 180;
  if (/\banual\b/.test(text)) return 365;
  return null;
}

export function interpretBusinessDescription(raw: string): DescriptionInterpretation {
  const empty: DescriptionInterpretation = {
    businessModel: null,
    vertical: null,
    buyerType: null,
    cycleUnknown: false,
    industry: null,
    catalogType: null,
    archetype: null,
    cycleDays: null,
    companyRequired: false,
    confidence: "baja",
    understood: [],
    questions: ["Cuéntame qué vendes y a quién se lo vendes."],
  };
  const text = norm(raw ?? "");
  if (text.trim().length < 10) return empty;

  const understood: string[] = [];

  // Modelo
  const hybridHit = HYBRID_WORDS.some((w) => text.includes(norm(w)));
  const b2b = hits(text, B2B_WORDS.map(norm));
  const b2c = hits(text, B2C_WORDS.map(norm));
  let businessModel: BusinessModel | null = null;
  if (hybridHit || (b2b > 0 && b2c > 0)) {
    businessModel = "hybrid";
    understood.push("Vendes a personas y a empresas");
  } else if (b2b > b2c && b2b > 0) {
    businessModel = "b2b";
    understood.push("Vendes a empresas");
  } else if (b2c > 0) {
    businessModel = "b2c";
    understood.push("Vendes a personas");
  }

  // Industria (mejor score)
  let industry: string | null = null;
  let best = 0;
  for (const ind of INDUSTRIES) {
    const s = hits(text, ind.words);
    if (s > best) {
      best = s;
      industry = ind.id;
    }
  }
  if (industry && best > 0) understood.push(`Te dedicas a ${industry}`);

  // Catálogo (puede ser mixto si dos tipos empatan fuerte)
  const scores = CATALOGS.map((c) => ({ id: c.id, s: hits(text, c.words) }));
  scores.sort((a, b) => b.s - a.s);
  let catalogType: CatalogType | null = scores[0].s > 0 ? scores[0].id : null;
  if (scores[0].s > 0 && scores[1].s > 0 && scores[0].s === scores[1].s) catalogType = "mixto";
  if (catalogType) understood.push(`Catálogo tipo ${catalogType.replace("_", " / ")}`);

  // Ciclo explícito
  const cycleDays = parseCycleDays(text);
  if (cycleDays) understood.push(`Recompra aprox. cada ${cycleDays} días`);

  // Arquetipo
  let archetype: ArchetypeId | null = null;
  if (businessModel === "hybrid") archetype = "hibrido";
  else if (businessModel === "b2b") {
    const recur = hits(text, ["reposicion", "recurrente", "mensual", "distribuidor", "distribuidora", "reabastecer", "pedido fijo", "frecuente"]);
    archetype = recur > 0 ? "b2b_recurrente" : "b2b_proyecto";
    understood.push(
      archetype === "b2b_recurrente" ? "Patrón: reposición recurrente" : "Patrón: compra por proyecto",
    );
  } else if (businessModel === "b2c" || (!businessModel && catalogType)) {
    if (catalogType === "moda_estacional") archetype = "b2c_moda";
    else if (catalogType === "durable") archetype = "b2c_durable";
    else if (catalogType) archetype = "b2c_consumible";
  }
  // Sin modelo pero con industria de moda/durable, igual inferir lado B2C
  if (!archetype && catalogType === "moda_estacional") {
    archetype = "b2c_moda";
    businessModel = "b2c";
  } else if (!archetype && catalogType === "durable") {
    archetype = "b2c_durable";
    businessModel = "b2c";
  }

  const axes = [businessModel, industry, catalogType, cycleDays].filter(Boolean).length;
  const confidence = axes >= 3 ? "alta" : axes === 2 ? "media" : "baja";

  const questions: string[] = [];
  if (!businessModel) questions.push("¿Vendes a personas, a empresas o a ambos?");
  if (!catalogType) questions.push("¿Cada cuánto te vuelve a comprar un cliente?");
  if (businessModel === "b2b" && !cycleDays) questions.push("¿Tus clientes te recompran fijo o por proyecto?");
  if (questions.length === 0 && confidence !== "alta") {
    questions.push("¿Algo más que deba saber (temporadas, ticket alto, suscripción)?");
  }

  return {
    businessModel,
    vertical: industry,
    buyerType: businessModel === "b2b" ? "empresa" : businessModel === "b2c" ? "persona" : null,
    cycleUnknown: false,
    industry,
    catalogType,
    archetype,
    cycleDays,
    companyRequired: businessModel === "b2b",
    confidence,
    understood,
    questions: questions.slice(0, 3),
  };
}
