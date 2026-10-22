// Contexto por línea de compra, en forma agnóstica al tipo de negocio.
// Une el contenido Nivel 1 (tabla item_content) resuelto con LA key elegida
// en settings (metadata_map.content, una sola) para agentes y GUI. Nunca
// expone URLs de archivos ni tokens (solo lo interpretado).
// Clave: la GUI/agentes se atan a este schema estable, no a las keys de cada negocio.
// REGLA DURA: de META sale única y exclusivamente lo de la key elegida en
// settings. Nada de otras keys (fechas, notas, variantes, booleans): sin key
// de contenido, contiene/categoria son null honestos.
import { createHash } from "node:crypto";
import { getSupabase } from "@/lib/supabase";
import { EMPTY_KEYS, type ResolvedItemKeys } from "@/lib/metadata-map";

/** sha256 hex de la URL: misma clave que el backfill (dedup por contenido). */
function contentUrlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export interface EnrichedOrderItem {
  title: string;
  quantity: number;
  /** Sobre qué es la línea (contenido IA o catálogo, "marca: qué") o null. Solo con la key de contenido elegida en settings. */
  contiene: string | null;
  /** Categoría del contenido o null. Solo con la key de contenido elegida en settings. */
  categoria: string | null;
}

/**
 * Enriquece líneas con contenido Nivel 1 (1 sola query a item_content por todas).
 * Solo la key elegida en settings (metadata_map.content): sin key no hay
 * lookup y contiene/categoria son null honestos. Ninguna otra key del metadata
 * crudo fluye al engine/agentes (ni fechas, ni notas, ni variantes).
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
    const u = md && typeof md[keys.file] === "string" ? md[keys.file] as string : null;
    const cap = (u && contents.get(urls.get(u) as string)) || null;
    const marca = cap && typeof cap.marca === "string" ? cap.marca.trim() : "";
    const que = cap && typeof cap.que_anuncia === "string" ? cap.que_anuncia.trim() : "";
    const cat = cap && typeof cap.categoria === "string" ? cap.categoria.trim() : "";
    const contiene = que ? `${marca ? `${marca}: ` : ""}${que}`.slice(0, 240) : null;
    return {
      title: r.title,
      quantity: r.quantity,
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
