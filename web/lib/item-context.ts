// Contexto de metadata por línea de compra, en forma tenant-agnóstica.
// Une metadata crudo (Medusa, cualquier key) + captions Nivel 1 (media_captions)
// para agentes y GUI. Nunca expone URLs de S3 ni tokens (solo lo interpretado).
// Clave: la GUI/agentes se atan a este schema estable, no a las keys de cada tenant.
import { createHash } from "node:crypto";
import { getSupabase } from "@/lib/supabase";

/** sha256 hex de la URL: misma clave que el backfill (dedup por creativo). */
function mediaUrlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/** Keys con semántica conocida: se extraen a campos propios, no a `detalles`. */
const KNOWN_KEYS = new Set([
  "media_file",
  "media_comments",
  "dateStart",
  "dateEnd",
  "media_file_approved",
]);

/** Nunca al prompt/GUI: secretos y tokens internos (ej. media_file_approval_token). */
const SECRET_KEY_RE = /token|secret|password|signature/i;

export interface EnrichedOrderItem {
  title: string;
  quantity: number;
  /** Rango de pauta "2026-07-10→2026-07-11" (dateStart/dateEnd) o null. */
  pauta: string | null;
  /** Lo que tecleó el cliente (media_comments) o null. Fuente humana: citar, no mezclar. */
  clienteDijo: string | null;
  /** Lo que contiene la pieza (caption IA, "marca: qué anuncia") o null. */
  contiene: string | null;
  categoria: string | null;
  /** Resto de metadata escalar (talla, color, aroma, expediente…), sanitizado. */
  detalles: Record<string, string | number | boolean>;
}

function shortDate(v: unknown): string | null {
  const s = String(v ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Parte determinista (sin DB): pauta + clienteDijo + detalles desde metadata crudo. */
function rawItemContext(
  metadata: Record<string, unknown> | null | undefined,
): Pick<EnrichedOrderItem, "pauta" | "clienteDijo" | "detalles"> {
  const md = metadata ?? {};
  const start = shortDate(md.dateStart);
  const end = shortDate(md.dateEnd);
  const comments = String(md.media_comments ?? "").trim();
  const detalles: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(md)) {
    if (KNOWN_KEYS.has(k) || SECRET_KEY_RE.test(k)) continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    const s = String(v).trim();
    if (!s || s.length > 200 || /^https?:\/\//i.test(s)) continue;
    detalles[k] = typeof v === "string" ? s : v;
  }
  return {
    pauta: start && end ? (start === end ? start : `${start}→${end}`) : (start ?? end),
    clienteDijo: comments || null,
    detalles,
  };
}

/**
 * Enriquece líneas con captions (1 sola query a media_captions por todas).
 * Sin caption (sin media o aún no procesada) → contiene/categoria null, sin fallar.
 */
export async function enrichOrderItems(
  storeId: string,
  raw: Array<{ title: string; quantity: number; metadata?: unknown }>,
): Promise<EnrichedOrderItem[]> {
  const urls = new Map<string, string>();
  for (const r of raw) {
    const md = (r.metadata as Record<string, unknown> | null) ?? null;
    const u = md && typeof md.media_file === "string" ? md.media_file : null;
    if (u && !urls.has(u)) urls.set(u, mediaUrlHash(u));
  }
  let captions = new Map<string, Record<string, unknown>>();
  if (urls.size > 0) {
    const { data } = await getSupabase()
      .from("media_captions")
      .select("media_hash,caption_json")
      .eq("store_id", storeId)
      .in("media_hash", [...urls.values()]);
    captions = new Map(
      ((data as Array<{ media_hash: string; caption_json: unknown }> | null) ?? [])
        .filter((r) => r.caption_json && typeof r.caption_json === "object")
        .map((r) => [r.media_hash as string, r.caption_json as Record<string, unknown>]),
    );
  }
  return raw.map((r) => {
    const md = (r.metadata as Record<string, unknown> | null) ?? null;
    const base = rawItemContext(md);
    const u = md && typeof md.media_file === "string" ? md.media_file : null;
    const cap = (u && captions.get(urls.get(u) as string)) || null;
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

/** Coincidencia de contenido pautado (caption Nivel 1) para búsqueda. */
export interface ContentHit {
  marca: string | null;
  que: string;
  categoria: string | null;
}

/**
 * Customers cuyo contenido pautado matchea `term` (marca/categoría/qué/texto).
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
  const { data, error } = await db.rpc("search_content_customers", {
    p_store: storeId,
    p_term: term.trim(),
    p_limit: maxUrls,
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
