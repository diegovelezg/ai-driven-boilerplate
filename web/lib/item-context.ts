// Contexto por línea de compra, en forma agnóstica al tipo de negocio.
// Une metadata crudo (cualquier key según el tipo de negocio) + contenido
// Nivel 1 (tabla item_content) para agentes y GUI. Nunca expone URLs de
// archivos ni tokens (solo lo interpretado).
// Clave: la GUI/agentes se atan a este schema estable, no a las keys de cada negocio.
import { createHash } from "node:crypto";
import { getSupabase } from "@/lib/supabase";
import { EMPTY_KEYS, type ResolvedItemKeys } from "@/lib/metadata-map";

/** sha256 hex de la URL: misma clave que el backfill (dedup por contenido). */
function contentUrlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/** Nunca al prompt/GUI: secretos y tokens internos. */
const SECRET_KEY_RE = /token|secret|password|signature|api[-_]?key|access[-_]?key|private[-_]?key/i;

export interface EnrichedOrderItem {
  title: string;
  quantity: number;
  /** Ventana "2026-07-10→2026-07-11" (start/end) o null: pauta, turno, reserva… */
  ventana: string | null;
  /** Lo que escribió el cliente (comentario/nota) o null. Fuente humana: citar, no mezclar. */
  clienteDijo: string | null;
  /** Sobre qué es la línea (contenido IA o catálogo, "marca: qué") o null. */
  contiene: string | null;
  categoria: string | null;
  /** Resto de metadata (texto corto/número con su key: talla, color…), sanitizado. */
  detalles: Record<string, string | number>;
  /** Material aprobado (booleano *approved) o null si sin señal. */
  aprobado: boolean | null;
}

/** Texto con pinta de prosa humana (vs código corto): va citado, no a detalles.
 *  Decisión KISS conocida: el umbral puede dejar fuera citado corto y cualquier
 *  fecha con forma AAAA-MM-DD arma ventana. Válvula: "No mandar" por campo. */
const PROSE_MIN = 24;

/** Parte determinista (sin DB): ventana + citado + detalles + aprobado.
 *  Sin preguntas: las fechas (forma AAAA-MM-DD) arman la ventana, la prosa
 *  humana se cita, el resto (texto corto/número, sin URLs ni secretos) cae a
 *  detalles tipados con su key. Los booleanos *approved alimentan `aprobado`
 *  (el material aprobado sí dirige la jugada); el resto se omite. Los roles
 *  del mapa (fecha/nota/variante) confirman la clasificación por forma. */
function rawItemContext(
  metadata: Record<string, unknown> | null | undefined,
  keys: ResolvedItemKeys,
): Pick<EnrichedOrderItem, "ventana" | "clienteDijo" | "detalles" | "aprobado"> {
  const md = metadata ?? {};
  const skip = new Set(keys.exclude ?? []);
  const roles = keys.roles ?? {};
  const fechaRole = new Set(roles.fecha ?? []);
  const notaRole = new Set(roles.nota ?? []);
  const varianteRole = new Set(roles.variante ?? []);
  const archivoRole = new Set(roles.archivo ?? []);
  if (keys.file) archivoRole.add(keys.file);
  const dates: string[] = [];
  const prose: string[] = [];
  const detalles: Record<string, string | number> = {};
  let aprobado: boolean | null = null;
  const hasFechaRoles = fechaRole.size > 0;
  const hasVarianteRoles = varianteRole.size > 0;
  for (const [k, v] of Object.entries(md)) {
    if (skip.has(k) || SECRET_KEY_RE.test(k)) continue;
    if (archivoRole.has(k) && typeof v === "string" && /^https?:\/\//i.test(v.trim())) continue;
    if (typeof v === "boolean") {
      if (/approv|aprob/i.test(k)) aprobado = v;
      continue;
    }
    if (typeof v !== "string" && typeof v !== "number") continue;
    const s = String(v).trim();
    if (!s || s.length > 200 || /^https?:\/\//i.test(s)) continue;
    const isDateShape = typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(s);
    if (isDateShape) {
      // Con roles fecha declarados, solo esas keys arman ventana; sin roles,
      // cualquier forma fecha arma ventana (fail-open agnóstico).
      if (!hasFechaRoles || fechaRole.has(k)) dates.push(s.slice(0, 10));
      continue;
    }
    if (notaRole.has(k)) {
      if (typeof v === "string") prose.push(s);
      else detalles[k] = v;
      continue;
    }
    if (typeof v === "string" && s.length >= PROSE_MIN) {
      prose.push(s);
      continue;
    }
    // Texto corto / número: con roles variante declarados, solo variante va
    // a detalles; el resto es ruido y se omite (no bloat del prompt).
    if (hasVarianteRoles && !varianteRole.has(k)) continue;
    detalles[k] = typeof v === "string" ? s : v;
  }
  dates.sort();
  const ventana =
    dates.length === 0 ? null : dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]}→${dates[dates.length - 1]}`;
  return {
    ventana,
    clienteDijo: prose.length > 0 ? prose.join(" / ").slice(0, 400) : null,
    detalles,
    aprobado,
  };
}

/**
 * Enriquece líneas con contenido Nivel 1 (1 sola query a item_content por todas).
 * Sin contenido (sin archivo o aún no procesado) → contiene/categoria null, sin fallar.
 */
export async function enrichOrderItems(
  storeId: string,
  raw: Array<{ title: string; quantity: number; metadata?: unknown }>,
  keys: ResolvedItemKeys = EMPTY_KEYS,
): Promise<EnrichedOrderItem[]> {
  const urls = new Map<string, string>();
  for (const r of raw) {
    const md = (r.metadata as Record<string, unknown> | null) ?? null;
    const u = md && typeof md[keys.file] === "string" ? md[keys.file] as string : null;
    if (u && !urls.has(u)) urls.set(u, contentUrlHash(u));
  }
  let contents = new Map<string, Record<string, unknown>>();
  if (urls.size > 0) {
    const { data } = await getSupabase()
      .from("item_content")
      .select("content_hash,content_json")
      .eq("store_id", storeId)
      .in("content_hash", [...urls.values()]);
    contents = new Map(
      ((data as Array<{ content_hash: string; content_json: unknown }> | null) ?? [])
        .filter((r) => r.content_json && typeof r.content_json === "object")
        .map((r) => [r.content_hash as string, r.content_json as Record<string, unknown>]),
    );
  }
  return raw.map((r) => {
    const md = (r.metadata as Record<string, unknown> | null) ?? null;
    const base = rawItemContext(md, keys);
    const u = md && typeof md[keys.file] === "string" ? md[keys.file] as string : null;
    const cap = (u && contents.get(urls.get(u) as string)) || null;
    const marca = cap && typeof cap.marca === "string" ? cap.marca.trim() : "";
    const que = cap && typeof cap.que_anuncia === "string" ? cap.que_anuncia.trim() : "";
    const cat = cap && typeof cap.categoria === "string" ? cap.categoria.trim() : "";
    const contiene = que ? `${marca ? `${marca}: ` : ""}${que}`.slice(0, 240) : null;
    return {
      title: r.title,
      quantity: r.quantity,
      ...base,
      contiene,
      categoria: cat || null,
    };
  });
}

/** Coincidencia de contenido (Nivel 1) para búsqueda. */
export interface ContentHit {
  marca: string | null;
  que: string;
  categoria: string | null;
}

/**
 * Customers cuyo contenido matchea `term` (marca/categoría/qué/texto).
 * Devuelve customerId → mejor hit. Para el buscador GUI y find_customer.
 * Mecanismo único: función SQL `search_content_customers` (pg_trgm: fuzzy
 * ante apóstrofes/plurales/typos, sin reglas ad-hoc en la app).
 */
export async function searchContentCustomerIds(
  storeId: string,
  term: string,
  maxUrls = 40,
): Promise<Map<string, ContentHit>> {
  const out = new Map<string, ContentHit>();
  if (term.trim().length < 2) return out;
  const db = getSupabase();
  // La key del archivo varía por tenant (settings → metadata_map): sin ella
  // el join SQL no matchea (file "" = sin lookup, honesto).
  const { resolveItemKeys } = await import("@/lib/metadata-map");
  const keys = await resolveItemKeys(storeId).catch(() => null);
  const { data, error } = await db.rpc("search_content_customers", {
    p_store: storeId,
    p_term: term.trim(),
    p_limit: maxUrls,
    p_file_key: keys?.file ?? "",
  });
  if (error) throw new Error(`Content search: ${error.message}`);
  for (const r of ((data as Array<Record<string, unknown>> | null) ?? [])) {
    const cid = String(r.customer_id ?? "");
    if (!cid || out.has(cid)) continue;
    out.set(cid, {
      marca: (r.marca as string) ?? null,
      que: String(r.que ?? "").slice(0, 160),
      categoria: (r.categoria as string) ?? null,
    });
  }
  return out;
}
