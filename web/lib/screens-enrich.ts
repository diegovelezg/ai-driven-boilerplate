// Enriquecimiento geoespacial + comercial por pantalla (port de
// tupantalla-asistente/tenants/dooh-tupantalla).
//
// Se ejecuta best-effort cada vez que se crea un screen con lat/lng:
// Mapbox (geocoding + POIs + tilequery + directions) → métricas derivadas
// (dwell/VAC/score/mix) → tags + rubros + narrativa LLM → embedding.
// Nunca lanza: si falta token o falla la red, la pantalla queda creada
// con lo determinista que se pudo calcular.
import { getSupabase } from "@/lib/supabase";
import { chatCompletionParams, getLlmConfig, reasoningBody } from "@/lib/ai/llm-config";
import { logLlmUsage, parseChatUsage } from "@/lib/ai/usage";

function mapboxToken(): string | null {
  const t = (
    process.env.MAPBOX_ACCESS_TOKEN ||
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN ||
    ""
  ).trim();
  return t || null;
}

export interface AdminLocation {
  district: string;
  city: string;
  region: string;
  address: string | null;
  neighborhood: string | null;
  postalCode: string | null;
  fullFormattedAddress: string;
}

export interface PoiItem {
  category: string;
  name: string;
  distance: number;
  address?: string;
}

export interface GeoResult {
  admin: AdminLocation;
  perfilPrimario: string;
  perfilSecundario: string;
  scoreIntensidad: number;
  scoresFull: Record<string, number>;
  anclas: string[];
  categoriasPrincipales: Array<{ categoria: string; cantidad: number; ejemplos: string[] }>;
  primaryRoadClass: string;
  roadTierLabel: string;
  isMajorCorridor: boolean;
  roadClasses: string[];
  landuseZones: string[];
  buildingTypes: string[];
  averageSpeedKmh: number;
  congestionLevel: string;
  trafficScore: number;
  dwellFactor: number;
  vehicularPct: number;
  pedestrianPct: number;
  pois: PoiItem[];
  countsByCategory: Record<string, number>;
}

const CATEGORIAS_BUSQUEDA = [
  "food_and_drink",
  "shopping",
  "services",
  "health_and_beauty",
  "education",
  "hotel",
  "nightlife",
];

const MATRIZ_PERFILES: Record<string, Record<string, number>> = {
  food_and_drink: { business_executive: 2.0, daily_life: 1.5, gen_z_lifestyle: 2.5, high_end_luxury: 1.5, health_wellness: 0.5 },
  shopping: { daily_life: 3.0, business_executive: 0.5, high_end_luxury: 2.5, gen_z_lifestyle: 1.5 },
  health_and_beauty: { health_wellness: 3.0, daily_life: 2.0, business_executive: 0.5, high_end_luxury: 1.5 },
  education: { gen_z_lifestyle: 2.5, business_executive: 1.5, daily_life: 1.0 },
  services: { business_executive: 2.5, daily_life: 2.0, high_end_luxury: 1.0 },
  hotel: { travel_transit: 3.0, business_executive: 2.5, high_end_luxury: 2.5 },
  nightlife: { gen_z_lifestyle: 3.0, high_end_luxury: 2.0, business_executive: 1.0 },
};

function cleanPrefix(s: string | null): string {
  if (!s) return "";
  return s.replace(/^(Distrito de|Provincia de|Departamento de|Provincia Constitucional del)\s+/i, "").trim();
}

function normalizeAdminPeru(features: Array<{ place_type?: string[]; text?: string }>): AdminLocation {
  let rawAddress: string | null = null;
  let rawNeighborhood: string | null = null;
  let rawLocality: string | null = null;
  let rawPlace: string | null = null;
  let rawRegion: string | null = null;
  let rawPostcode: string | null = null;
  let fullFormatted = "";
  if (features?.length) {
    fullFormatted = (features[0] as { place_name?: string }).place_name ?? "";
    for (const f of features) {
      const types = f.place_type ?? [];
      if (types.includes("address") && !rawAddress) rawAddress = f.text ?? null;
      if (types.includes("neighborhood") && !rawNeighborhood) rawNeighborhood = f.text ?? null;
      if ((types.includes("locality") || types.includes("district")) && !rawLocality) rawLocality = f.text ?? null;
      if (types.includes("place") && !rawPlace) rawPlace = f.text ?? null;
      if (types.includes("region") && !rawRegion) rawRegion = f.text ?? null;
      if (types.includes("postcode") && !rawPostcode) rawPostcode = f.text ?? null;
    }
  }
  const regionClean = cleanPrefix(rawRegion);
  const placeClean = cleanPrefix(rawPlace);
  const localityClean = cleanPrefix(rawLocality);
  let city = placeClean || regionClean || "Perú";
  let district = localityClean || placeClean || "";
  if (regionClean.toLowerCase().includes("lima")) {
    city = "Lima";
    district = rawPlace && rawPlace.toLowerCase() !== "lima" ? placeClean : localityClean || "Lima";
  } else if (regionClean.toLowerCase().includes("callao")) {
    city = "Callao";
    district = placeClean || localityClean || "Callao";
  } else {
    city = placeClean || regionClean;
    district = localityClean || placeClean || city;
  }
  return {
    address: rawAddress,
    neighborhood: rawNeighborhood,
    district: district || city,
    city: city || "Lima",
    region: regionClean || city,
    postalCode: rawPostcode,
    fullFormattedAddress: fullFormatted,
  };
}

function roadHierarchy(roadClasses: string[]): { primary: string; tierLabel: string; isMajor: boolean } {
  const order = ["motorway", "trunk", "primary", "secondary", "tertiary", "street", "service"];
  let primary = "street";
  for (const p of order) {
    if (roadClasses.includes(p)) {
      primary = p;
      break;
    }
  }
  if (primary === "motorway" || primary === "trunk")
    return { primary, tierLabel: "Autopista / Vía Expresa (Flujo vehicular masivo interurbano)", isMajor: true };
  if (primary === "primary") return { primary, tierLabel: "Avenida Metropolitana Principal (Alto aforo vehicular)", isMajor: true };
  if (primary === "secondary") return { primary, tierLabel: "Avenida Colectora Comercial (Tráfico distrital activo)", isMajor: false };
  return { primary, tierLabel: "Vía de Conexión Local", isMajor: false };
}

async function fetchJson(url: string, ms: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function analyzeCoordinates(lat: number, lng: number, token: string): Promise<GeoResult> {
  const geoP = fetchJson(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${token}&language=es`,
    15_000,
  );
  const poiPs = CATEGORIAS_BUSQUEDA.map(async (cat): Promise<PoiItem[]> => {
    const data = await fetchJson(
      `https://api.mapbox.com/search/searchbox/v1/category/${cat}?proximity=${lng},${lat}&limit=10&access_token=${token}&language=es`,
      15_000,
    );
    const out: PoiItem[] = [];
    const feats = (data?.features as Array<Record<string, unknown>> | undefined) ?? [];
    for (const f of feats) {
      const props = (f.properties as Record<string, unknown> | undefined) ?? {};
      const dist = Number(props.distance ?? 0);
      const name = typeof props.name === "string" ? props.name : "";
      if (dist <= 500 && name) {
        out.push({ category: cat, name, distance: dist, address: typeof props.place_formatted === "string" ? props.place_formatted : undefined });
      }
    }
    return out;
  });
  const tileP = fetchJson(
    `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lng},${lat}.json?radius=400&limit=50&layers=road,landuse,building&access_token=${token}`,
    15_000,
  );
  const [geoData, poiArrays, tileData] = await Promise.all([geoP, Promise.all(poiPs), tileP]);

  const admin = normalizeAdminPeru(((geoData?.features ?? []) as GeoResult["pois"] as unknown as Array<{ place_type?: string[]; text?: string }>) ?? []);

  const allPois = poiArrays.flat().sort((a, b) => a.distance - b.distance);
  const counts: Record<string, number> = {};
  const comercios: Record<string, string[]> = {};
  const seen = new Set<string>();
  const anclas: string[] = [];
  for (const p of allPois) {
    counts[p.category] = (counts[p.category] ?? 0) + 1;
    if (!comercios[p.category]) comercios[p.category] = [];
    if (!comercios[p.category].includes(p.name)) comercios[p.category].push(p.name);
    if (!seen.has(p.name)) {
      seen.add(p.name);
      anclas.push(p.name);
    }
  }

  const landuseSet = new Set<string>();
  const buildingSet = new Set<string>();
  const roadSet = new Set<string>();
  const feats = (tileData?.features as Array<Record<string, unknown>> | undefined) ?? [];
  for (const f of feats) {
    const props = (f.properties as { tilequery?: { layer?: string }; class?: string; type?: string } | undefined) ?? {};
    const layer = props.tilequery?.layer;
    const type = props.class ?? props.type ?? "";
    if (layer === "landuse" && type) landuseSet.add(type);
    if (layer === "building" && type) buildingSet.add(type);
    if (layer === "road" && type) roadSet.add(type);
  }
  const landuseZones = [...landuseSet];
  const buildingTypes = [...buildingSet];
  const roadClasses = [...roadSet];
  const road = roadHierarchy(roadClasses);

  let speedKmh = 20;
  let congestionLevel = "unknown";
  try {
    const dir = await fetchJson(
      `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${lng},${lat};${lng + 0.003},${lat + 0.003}?overview=full&annotations=congestion,speed,duration&access_token=${token}`,
      15_000,
    );
    const route = (dir?.routes as Array<Record<string, unknown>> | undefined)?.[0];
    const leg = (route?.legs as Array<Record<string, unknown>> | undefined)?.[0];
    const ann = (leg?.annotation as { congestion?: string[]; speed?: number[] } | undefined) ?? {};
    const congestions = ann.congestion ?? [];
    const speeds = ann.speed ?? [];
    const summary: Record<string, number> = {};
    for (const c of congestions) summary[c] = (summary[c] ?? 0) + 1;
    if (speeds.length > 0) speedKmh = Math.round(((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 3.6) * 10) / 10;
    if (summary.severe > 0) congestionLevel = "severe";
    else if (summary.heavy > 0) congestionLevel = "heavy";
    else if (summary.moderate > 0) congestionLevel = "moderate";
    else if (summary.low > 0) congestionLevel = "low";
    else congestionLevel = "unknown";
  } catch {
    // telemetría best-effort
  }

  let dwellFactor = 0.7;
  if (speedKmh <= 20) dwellFactor = 0.85;
  else if (speedKmh <= 35) dwellFactor = 0.75;
  else if (speedKmh <= 55) dwellFactor = 0.6;
  else dwellFactor = 0.45;

  let vehPct = 75;
  let peatPct = 25;
  if (road.primary === "motorway" || road.primary === "trunk") {
    vehPct = 92;
    peatPct = 8;
  } else if (landuseZones.includes("commercial_area") || landuseZones.includes("retail")) {
    vehPct = 55;
    peatPct = 45;
  } else if (road.primary === "primary") {
    vehPct = 80;
    peatPct = 20;
  }

  let ptsJerarquia = 15;
  if (road.primary === "motorway" || road.primary === "trunk") ptsJerarquia = 40;
  else if (road.primary === "primary") ptsJerarquia = 35;
  else if (road.primary === "secondary") ptsJerarquia = 25;
  // Nodos de transporte: solo estaciones/terminales por nombre. Los hoteles
  // (`category === 'hotel'`) se excluyen a propósito (issue #1 P1b): ya
  // aportan a `travel_transit` vía la matriz de perfiles y aquí llegaban a
  // dominar el score (caso Dos de Mayo: 7 hoteles = 30/50 pts). Doble conteo.
  const poisTransporte = allPois.filter(
    (p) => p.name.toLowerCase().includes("estacion") || p.name.toLowerCase().includes("terminal"),
  ).length;
  const ptsNodos = Math.min(poisTransporte * 7, 30);
  let ptsCruces = 0;
  if (roadClasses.length >= 3) ptsCruces += 10;
  if (landuseZones.includes("commercial_area") || landuseZones.includes("retail")) ptsCruces += 10;
  ptsCruces = Math.min(ptsCruces, 20);
  const trafficScore = Math.min(ptsJerarquia + ptsNodos + ptsCruces + 5, 100);

  const scores: Record<string, number> = {
    business_executive: 0,
    daily_life: 0,
    health_wellness: 0,
    gen_z_lifestyle: 0,
    high_end_luxury: 0,
    travel_transit: 0,
  };
  for (const [cat, count] of Object.entries(counts)) {
    const pesos = MATRIZ_PERFILES[cat];
    if (!pesos) continue;
    const concentracion = Math.pow(count, 0.65);
    for (const [perfil, peso] of Object.entries(pesos)) scores[perfil] += concentracion * peso;
  }
  if (landuseZones.includes("commercial_area") || landuseZones.includes("retail")) {
    scores.business_executive += 3;
    scores.high_end_luxury += 2;
  }
  if (landuseZones.includes("residential")) scores.daily_life += 3;
  if (road.isMajor) {
    scores.travel_transit += 3;
    scores.business_executive += 1.5;
  }
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const scoreIntensidad = Math.round(Math.min((allPois.length / 35) * 100, 100) * 10) / 10;

  return {
    admin,
    perfilPrimario: sorted[0]?.[0] ?? "daily_life",
    perfilSecundario: sorted[1]?.[0] ?? "business_executive",
    scoreIntensidad,
    scoresFull: scores,
    anclas: anclas.slice(0, 10),
    categoriasPrincipales: Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([cat, count]) => ({ categoria: cat, cantidad: count, ejemplos: (comercios[cat] ?? []).slice(0, 3) })),
    primaryRoadClass: road.primary,
    roadTierLabel: road.tierLabel,
    isMajorCorridor: road.isMajor,
    roadClasses,
    landuseZones,
    buildingTypes,
    averageSpeedKmh: speedKmh,
    congestionLevel,
    trafficScore,
    dwellFactor,
    vehicularPct: vehPct,
    pedestrianPct: peatPct,
    pois: allPois,
    countsByCategory: counts,
  };
}

// --- Comercial determinista (port de prompt-builder.ts) ---

const CONFIG_PERFILES: Record<string, { displayName: string; mindset: string; argumento: string; clientes: string; keywords: string[] }> = {
  business_executive: {
    displayName: "Comercial, Negocios y Servicios Profesionales",
    mindset: "Enfocado en crecimiento empresarial, compras de alto valor, inversiones y servicios clave.",
    argumento: "Conecta con conductores, profesionales, ejecutivos y clientes con alta capacidad de compra.",
    clientes: "Concesionarios de autos y motos, inmobiliarias y constructoras, clínicas dentales y estéticas, casinos y entretenimiento, notarías y estudios contables, cooperativas financieras y emprendimientos.",
    keywords: ["Negocios", "Concesionarios", "Inmobiliarias", "Finanzas", "Clínicas", "Casinos", "Emprendimientos", "Autos"],
  },
  daily_life: {
    displayName: "Comercio Local, Familia y Barrio",
    mindset: "Orientado a la resolución de compras cotidianas, alimentación familiar y servicios para el hogar.",
    argumento: "Impacta a vecinos, familias y compradores habituales en sus rutas diarias de consumo.",
    clientes: "Pollerías y restaurantes locales, veterinarias y pet shops, clínicas dentales, talleres mecánicos, ferreterías, colegios privados y academias, gimnasios y bodegas.",
    keywords: ["Familia", "Restaurantes", "Veterinarias", "Pollerías", "Ferreterías", "Dentistas", "Colegios", "Barrio"],
  },
  high_end_luxury: {
    displayName: "Estilo de Vida, Gastronomía y Experiencias",
    mindset: "Sensible a la calidad, la buena mesa, el entretenimiento exclusivo y el cuidado personal.",
    argumento: "Posiciona tu marca ante un público de buen poder adquisitivo y hábitos de consumo activo.",
    clientes: "Restaurantes gourmet y restobares, concesionarios de vehículos, centros de estética y spas, boutiques de moda independiente, hoteles boutique y desarrollos inmobiliarios.",
    keywords: ["Gourmet", "Restobares", "Boutiques", "Estética", "Concesionarios", "Inmobiliarias", "Hoteles"],
  },
  gen_z_lifestyle: {
    displayName: "Jóvenes, Vida Nocturna y Entretenimiento",
    mindset: "Social, dinámico, buscador de diversión, conciertos, gastronomía nocturna y tendencias.",
    argumento: "Capta la atención de jóvenes y grupos de amigos en sus momentos de salida y ocio.",
    clientes: "Conciertos y productoras de eventos, discotecas, bares y restobares, salas de juegos y casinos, canchas sintéticas, hamburgueserías y fast food, academias e institutos, tiendas de moda urbana.",
    keywords: ["Conciertos", "Discotecas", "Bares", "Casinos", "Fast Food", "Academias", "Eventos", "Jóvenes", "Diversión"],
  },
  health_wellness: {
    displayName: "Salud, Bienestar y Cuidado Personal",
    mindset: "Consciente del cuidado de la salud, la actividad física y el bienestar familiar.",
    argumento: "Llega directamente a personas que buscan servicios médicos, estética y vida activa.",
    clientes: "Clínicas dentales y ortodoncia, centros médicos y policlínicos, veterinarias, gimnasios y crossfit, ópticas, spas y salones de belleza, farmacias locales.",
    keywords: ["Salud", "Dentistas", "Veterinarias", "Clínicas", "Gimnasios", "Ópticas", "Estética", "Bienestar"],
  },
  travel_transit: {
    displayName: "Movilidad, Rutas y Tránsito Continuo",
    mindset: "En desplazamiento continuo entre distritos, receptivo a servicios en ruta y comercios de paso.",
    argumento: "Máxima visibilidad ante miles de conductores, pasajeros y transporte diario.",
    clientes: "Concesionarios de autos usados y nuevos, llanterías y talleres automotrices, grifos y estaciones de servicio, casinos y discotecas, restaurantes campestres y hoteles.",
    keywords: ["Concesionarios", "Talleres", "Autos", "Casinos", "Hoteles", "Tránsito", "Movilidad"],
  },
};

function construirRubros(params: { perfilPrimario: string; anclas: string[]; poisNombres: string[]; isMajorCorridor: boolean }): string[] {
  const set = new Set<string>();
  const texto = (params.anclas.join(" ") + " " + params.poisNombres.join(" ")).toLowerCase();
  const has = (...ks: string[]) => ks.some((k) => texto.includes(k));
  if (has("veterinaria", "pet", "animal")) set.add("veterinarias y pet shops");
  if (has("dental", "odont", "dentaris", "multident")) set.add("clínicas dentales y ortodoncia");
  if (has("médic", "clinic", "salud", "farma", "botica")) set.add("centros médicos y policlínicos");
  if (has("óptica", "vision", "lentes")) set.add("ópticas y salud visual");
  if (has("teatro", "estadio", "concierto", "evento") || params.isMajorCorridor || params.perfilPrimario === "gen_z_lifestyle")
    set.add("productoras de eventos y conciertos");
  if (has("casino", "tragamonedas", "apuesta") || params.isMajorCorridor) set.add("casinos y salas de entretenimiento");
  if (has("disco", "bar", "club", "night") || params.perfilPrimario === "gen_z_lifestyle") set.add("discotecas, bares y restobares");
  if (has("cancha", "futbol", "sport")) set.add("canchas sintéticas y complejos deportivos");
  if (params.isMajorCorridor || has("auto", "motor", "concesion", "car")) {
    set.add("concesionarios de autos y motos");
    set.add("talleres mecánicos y car wash");
  }
  if (has("pollo", "polleria", "kfc", "fast food", "burger")) set.add("pollerías y cadenas de comida rápida");
  if (has("restauran", "chifa", "cevich", "comida", "cafe", "starbucks")) set.add("restaurantes, cevicherías y cafeterías");
  if (has("colegio", "nido", "escuela", "instituto", "universidad", "academia")) set.add("colegios privados, nidos y academias");
  if (has("spa", "barber", "peluqu", "estetic", "uñas")) set.add("centros de estética, spas y salones de belleza");
  if (has("gym", "gimnasio", "fitness", "smart fit")) set.add("gimnasios y centros de entrenamiento");
  if (params.isMajorCorridor || has("inmobiliaria", "construct", "bienes raices")) set.add("proyectos inmobiliarios y constructoras");
  if (has("notaria", "abogado", "estudio", "banco", "caja", "cooperativa")) set.add("notarías, estudios profesionales y cooperativas financieras");
  if (set.size < 4) {
    const base = CONFIG_PERFILES[params.perfilPrimario]?.clientes ?? "";
    for (const c of base.split(",")) {
      const clean = c.trim().toLowerCase().replace(/\.$/, "");
      if (clean) set.add(clean);
    }
  }
  return [...set].slice(0, 8);
}

const TRADUCCION_CATEGORIAS: Record<string, string> = {
  food_and_drink: "Gastronomía y Restaurantes",
  shopping: "Comercio Local y Tiendas",
  health_and_beauty: "Salud, Odontología y Estética",
  education: "Educación y Academias",
  services: "Servicios Profesionales y Locales",
  hotel: "Hospedaje y Hotelería",
  nightlife: "Vida Nocturna y Entretenimiento",
};

function cap(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function generarTags(p1: string, p2: string, geo: GeoResult, district: string, city: string, rubros: string[]): string[] {
  const set = new Set<string>();
  if (district) set.add(cap(district));
  if (city && city !== district) set.add(cap(city));
  if (geo.isMajorCorridor) {
    set.add("Alto Tráfico");
    set.add("Avenida Principal");
  }
  for (const k of CONFIG_PERFILES[p1]?.keywords ?? []) set.add(cap(k));
  for (const k of CONFIG_PERFILES[p2]?.keywords ?? []) set.add(cap(k));
  for (const r of rubros) set.add(cap(r));
  for (const a of geo.anclas) {
    if (a && !a.toLowerCase().includes("sin nombre")) set.add(a.trim().slice(0, 60));
  }
  for (const c of geo.categoriasPrincipales) set.add(cap(TRADUCCION_CATEGORIAS[c.categoria] ?? c.categoria.replace(/_/g, " ")));
  return [...set].slice(0, 40);
}

// --- LLM: narrativa comercial (texto libre, best-effort) ---

async function completeText(system: string, user: string, storeId: string): Promise<string> {
  const cfg = getLlmConfig("screen_narrative");
  const order = [cfg.primary, cfg.fallback].filter((r): r is NonNullable<typeof r> => Boolean(r));
  let lastErr: unknown = null;
  for (let i = 0; i < order.length; i++) {
    const ref = order[i];
    const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
    if (!apiKey) {
      lastErr = new Error(`Falta ${ref.apiKeyEnv}`);
      continue;
    }
    const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const t0 = Date.now();
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: ref.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...chatCompletionParams(ref.provider, ref.model, cfg.temperature, cfg.maxTokens),
          ...reasoningBody(ref.provider, ref.model, cfg.reasoningEffort),
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`${ref.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      const usage = parseChatUsage(data);
      if (usage) {
        void logLlmUsage({
          storeId,
          process: "screen_narrative",
          provider: ref.provider,
          model: ref.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          reasoningTokens: usage.reasoningTokens,
          latencyMs: Date.now() - t0,
          usedFallback: i > 0,
        });
      }
      if (typeof content !== "string" || !content.trim()) throw new Error(`${ref.provider}: respuesta vacía`);
      return content.trim();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function generarEmbeddingGemini(texto: string): Promise<{ values: number[]; model: string } | null> {
  const key = (process.env.GEMINI_API_KEY ?? "").trim();
  if (!key) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text: texto.slice(0, 8000) }] },
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: 768,
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { embedding?: { values?: number[] } };
    const values = data?.embedding?.values;
    if (!values?.length) return null;
    return { values, model: "gemini-embedding-001" };
  } catch {
    return null;
  }
}

// --- Punto de entrada ---

export interface EnrichInput {
  screenName: string;
  widthM: number | null;
  heightM: number | null;
  widthPx: number | null;
  heightPx: number | null;
  impactDay: number | null;
  impressionsDay: number | null;
  durationSec: number | null;
  venueAddress: string | null;
}

/** Enriquecimiento best-effort de una pantalla recién creada. Nunca lanza. */
export async function enrichScreen(storeId: string, screenId: string): Promise<void> {
  const markDone = async () => {
    try {
      await getSupabase().from("inv_screens").update({ enrichment_status: "done" }).eq("store_id", storeId).eq("id", screenId);
    } catch {
      // best-effort
    }
  };
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("inv_screens")
      .select("id,name,width_m,height_m,width_px,height_px,impact_day,impressions_day,duration_sec,venue_id")
      .eq("store_id", storeId)
      .eq("id", screenId)
      .maybeSingle();
    if (error || !data) return;
    const row = data as Record<string, unknown>;
    const venueId = typeof row.venue_id === "string" ? row.venue_id : null;
    let lat: number | null = null;
    let lng: number | null = null;
    let venueCity: string | null = null;
    let venueDistrict: string | null = null;
    if (venueId) {
      const { data: v } = await db
        .from("inv_venues")
        .select("latitude,longitude,city,district,region,full_address")
        .eq("store_id", storeId)
        .eq("id", venueId)
        .maybeSingle();
      const venue = (v ?? null) as Record<string, unknown> | null;
      const la = Number(venue?.latitude);
      const ln = Number(venue?.longitude);
      if (Number.isFinite(la) && Number.isFinite(ln)) {
        lat = la;
        lng = ln;
      }
      venueCity = typeof venue?.city === "string" ? venue.city : null;
      venueDistrict = typeof venue?.district === "string" ? venue.district : null;
    }
    if (lat === null || lng === null) {
      await markDone();
      return;
    }

    const token = mapboxToken();
    let geo: GeoResult | null = null;
    if (token) {
      for (let i = 0; i < 3 && !geo; i++) {
        try {
          geo = await analyzeCoordinates(lat, lng, token);
        } catch {
          if (i < 2) await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    if (!geo) {
      await markDone();
      return;
    }

    const p1 = CONFIG_PERFILES[geo.perfilPrimario] ?? CONFIG_PERFILES.daily_life;
    const p2 = CONFIG_PERFILES[geo.perfilSecundario];
    const rubros = construirRubros({
      perfilPrimario: geo.perfilPrimario,
      anclas: geo.anclas,
      poisNombres: geo.pois.map((p) => p.name),
      isMajorCorridor: geo.isMajorCorridor,
    });
    const tags = generarTags(geo.perfilPrimario, geo.perfilSecundario, geo, geo.admin.district, geo.admin.city, rubros);

    const impact = typeof row.impact_day === "number" ? row.impact_day : 50000;
    const impressions = typeof row.impressions_day === "number" ? row.impressions_day : 700;
    const aforo = Math.max(Math.round(impact / Math.max(impressions, 1)), 1);
    const viewsPerSpot = Math.max(Math.round(aforo * geo.dwellFactor), 1);
    const effectiveDaily = viewsPerSpot * impressions;

    const categoriasMap: Record<string, string> = {
      food_and_drink: "restaurantes, pollerías, cafeterías y locales gastronómicos",
      shopping: "tiendas comerciales, galerías, zapaterías y bazares",
      health_and_beauty: "clínicas dentales, veterinarias, ópticas, spas y centros estéticos",
      education: "colegios, nidos, academias e institutos",
      services: "talleres automotrices, notarías, consultorios y oficinas profesionales",
      hotel: "hoteles y establecimientos de hospedaje",
      nightlife: "discotecas, restobares, salas de juego y entretenimiento nocturno",
    };
    const comercioAgrupado = geo.categoriasPrincipales
      .map((c) => categoriasMap[c.categoria] ?? c.categoria.replace(/_/g, " "))
      .join("; ");
    const screenName = String(row.name ?? "Pantalla Digital LED");
    const formatStr =
      row.width_m != null && row.height_m != null ? `Pantalla Digital LED ${row.width_m}x${row.height_m}m` : "Pantalla Digital LED Exterior";
    const district = geo.admin.district || venueDistrict || "";
    const city = geo.admin.city || venueCity || "Lima";

    let narrativa: string | null = null;
    try {
      narrativa = await completeText(
        `Eres un asesor comercial experto de publicidad digital exterior (DOOH) para emprendedores, negocios locales, medianas empresas y eventos en Perú. Tu tarea es redactar una descripción persuasiva, atractiva, fluida y clara para una pantalla publicitaria digital, pensada para captar el interés de dueños de negocios locales, concesionarios, clínicas dentales, veterinarias, productoras de eventos/conciertos, restaurantes, academias y comercios.\n\nREGLAS ESTRICTAS DE REDACCIÓN:\n1. IDIOMA 100% EN ESPAÑOL: PROHIBIDO terminantemente usar palabras en inglés como "spots", "dwell time", "branding", "SaaS", "Real Estate", "Telcos", "FMCG", "retail", etc.\n2. Longitud: 1 único párrafo continuo y fluido (110 a 150 palabras) en español.\n3. Tono comercial cercano, profesional y orientado a resultados (atraer clientes, llenar locales, generar ventas y recordación). NO menciones cifras técnicas de velocidad en km/h. Menciona explícitamente el distrito y la ciudad. Para reproducciones y alcance: menciona cómo "tu anuncio se reproduce X veces al día" con el volumen de "impactos diarios estimados". Integra los rubros sugeridos con la fórmula: "Ideal para captar clientes en negocios de..." o "Excelente para anunciar marcas y comercios de...".\n4. NODOS ANCLA Y GRANDES MARCAS: menciona SIEMPRE con su NOMBRE PROPIO real. NUNCA los generalices. Comercio local de barrio: descríbelo agrupado. Conectores: "Alrededor se encuentran...", "En las inmediaciones tienes...". PROHIBIDO "ecosistema".\n5. CERO relleno: sin introducciones, saludos ni viñetas. Empieza directo.\n6. NO inventes comercios ni calles que no vengan en los datos.`,
        `Datos de la pantalla:\n- Pantalla: ${screenName}\n- Medidas / Formato: ${formatStr}\n- Ubicación: ${district}, ${city} – Perú\n- Tráfico e Impactos: ${Math.round(impact).toLocaleString()} impactos diarios estimados | Tu anuncio se reproduce ${Math.round(impressions).toLocaleString()} veces al día\n- Jerarquía de Vía y Flujo: ${geo.roadTierLabel}${geo.isMajorCorridor ? " | Corredor troncal de alto aforo con tiempo de contacto visual prolongado." : " | Tránsito constante de proximidad y comercio local."}\n- Nivel Comercial de la Zona: ${geo.scoreIntensidad}/100\n- Marcas y Nodos Ancla (mencionar con NOMBRE PROPIO): ${geo.anclas.join(", ") || "No detectadas"}\n- Comercio del Entorno (agrupado): ${comercioAgrupado}\n- Público y Contexto: ${p1.displayName} (${p1.mindset} | ${p1.argumento})\n${p2 ? `- Público Complementario: ${p2.displayName} (${p2.argumento})\n` : ""}- Negocios y Rubros Sugeridos: ${rubros.join(", ")}\n\nGenera la descripción comercial 100% en español:`,
        storeId,
      );
    } catch {
      narrativa = null;
    }

    const searchText = [
      `${formatStr}: ${screenName}. Ubicación: ${district}, ${city}, Perú.`,
      narrativa ?? "",
      geo.anclas.length > 0 ? `Puntos clave y anclas del entorno: ${geo.anclas.join(", ")}.` : "",
      comercioAgrupado ? `Comercio en la zona: ${comercioAgrupado}.` : "",
      `Movilidad y tráfico: ${geo.roadTierLabel}. ${geo.isMajorCorridor ? "Corredor vial de alto aforo vehicular y máxima visibilidad exterior con tiempo de contacto visual prolongado." : "Vía urbana con tránsito continuo y comercio de proximidad."}`,
      `Perfil de audiencia: ${p1.displayName}${p2 ? ` y ${p2.displayName}` : ""}.`,
      `Ideal para captar clientes en negocios y comercios de: ${rubros.join(", ")}.`,
      `Tags: ${tags.join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const updatePayload: Record<string, unknown> = {
      enrichment_status: "done",
      description: narrativa,
      sales_pitch: `${p1.argumento}${p2 ? ` ${p2.argumento}` : ""}`,
      audience_target: `${p1.displayName}${p2 ? ` / ${p2.displayName}` : ""}\n\nEnfoque: ${p1.mindset}${p2 ? ` ${p2.mindset}` : ""}`,
      tags,
      score: geo.trafficScore,
      traffic_mobility_score: geo.trafficScore,
      commercial_intensity_score: Math.round(geo.scoreIntensidad),
      views_per_spot: viewsPerSpot,
      effective_daily_views: effectiveDaily,
      vehicular_pct: geo.vehicularPct,
      pedestrian_pct: geo.pedestrianPct,
      geo_daily_life: geo.scoresFull.daily_life ?? null,
      geo_travel_transit: geo.scoresFull.travel_transit ?? null,
      geo_gen_z_lifestyle: geo.scoresFull.gen_z_lifestyle ?? null,
      geo_health_wellness: geo.scoresFull.health_wellness ?? null,
      geo_high_end_luxury: geo.scoresFull.high_end_luxury ?? null,
      geo_business_executive: geo.scoresFull.business_executive ?? null,
      suggested_local_businesses: rubros.join(", "),
      landuse_zones: geo.landuseZones.join(", ") || null,
      building_types: geo.buildingTypes.join(", ") || null,
      pois_anchors: geo.anclas.join(", ") || null,
      pois_anchors_count: geo.anclas.length,
      pois_total_count: geo.pois.length,
      pois_list_json: geo.pois.slice(0, 25).map((p) => ({ name: p.name, category: p.category, distance_meters: p.distance, address: p.address ?? null })),
      road_tier_label: geo.roadTierLabel,
      congestion_level: geo.congestionLevel,
      average_speed_kmh: geo.averageSpeedKmh,
      is_major_corridor: geo.isMajorCorridor,
      primary_road_class: geo.primaryRoadClass,
      road_classes_detected: geo.roadClasses.join(", ") || null,
      source_attrs: {
        location_raw: {
          latitude: lat,
          longitude: lng,
          address: geo.admin.address,
          neighborhood: geo.admin.neighborhood,
          district: geo.admin.district,
          city: geo.admin.city,
          region: geo.admin.region,
          postal_code: geo.admin.postalCode,
          full_formatted_address: geo.admin.fullFormattedAddress,
        },
        traffic_mobility_raw: {
          average_speed_kmh: geo.averageSpeedKmh,
          congestion_level: geo.congestionLevel,
          primary_road_class: geo.primaryRoadClass,
          road_classes_detected: geo.roadClasses,
          road_tier_label: geo.roadTierLabel,
          is_major_corridor: geo.isMajorCorridor,
        },
        derived_metrics: {
          traffic_mobility_score: geo.trafficScore,
          commercial_intensity_score: geo.scoreIntensidad,
          dwell_time_retention_factor: geo.dwellFactor,
          views_per_spot: viewsPerSpot,
          effective_daily_views: effectiveDaily,
          audience_mix: { vehicularPct: geo.vehicularPct, pedestrianPct: geo.pedestrianPct },
          suggested_local_businesses: rubros,
          geo_scores: geo.scoresFull,
        },
      },
      updated_at: new Date().toISOString(),
    };
    if (!narrativa) delete updatePayload.description;
    await db.from("inv_screens").update(updatePayload).eq("store_id", storeId).eq("id", screenId);

    if (venueId && (!venueCity || !venueDistrict)) {
      await db
        .from("inv_venues")
        .update({
          district: venueDistrict || geo.admin.district,
          city: venueCity || geo.admin.city,
          region: geo.admin.region,
          full_address: geo.admin.fullFormattedAddress || undefined,
          updated_at: new Date().toISOString(),
        })
        .eq("store_id", storeId)
        .eq("id", venueId);
    }

    const emb = await generarEmbeddingGemini(searchText || `${screenName} ${district} ${city} ${tags.join(" ")}`);
    if (emb) {
      await db.from("inv_screen_embeddings").upsert(
        { screen_id: screenId, store_id: storeId, embedding: emb.values, model: emb.model },
        { onConflict: "screen_id" },
      );
    }
  } catch {
    // best-effort: la pantalla ya existe; el drawer muestra lo disponible.
    // Siempre liberar el pending para no bloquear la edición para siempre.
    await markDone();
  }
}
