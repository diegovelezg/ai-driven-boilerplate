// Mapeo de metadata por tenant (settings, human-in-the-loop).
// UNA sola pregunta: ¿qué campo trae el contenido a entender? (0-1 key).
// El resto se clasifica solo por forma: fechas → ventana, texto → citado,
// resto escalar → detalles. Sin roles, sin presets en código.
import { getSupabase } from "@/lib/supabase";

export interface MetadataMap {
  content?: string | null;
  /** Keys que no se mandan al engine (ni a detalles ni a citado). */
  exclude?: string[];
}

/** Key resuelta para el lector ("" = sin mapear: no hay lookup de contenido). */
export interface ResolvedItemKeys {
  file: string;
  exclude: string[];
}

export const EMPTY_KEYS: ResolvedItemKeys = { file: "", exclude: [] };

const SECRET_KEY_RE = /token|secret|password|signature|api[-_]?key|access[-_]?key|private[-_]?key/i;

export interface MetadataKeyInfo {
  key: string;
  /** % de líneas con la key presente (0-100). */
  freq: number;
  /** Tipo dominante observado. */
  kind: "url" | "date" | "text" | "number" | "boolean";
  samples: string[];
}

function sampleKind(v: unknown): MetadataKeyInfo["kind"] | null {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return "url";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return "date";
  return "text";
}

function maskSample(v: unknown): string | null {
  const k = sampleKind(v);
  if (!k) return null;
  if (k === "url") {
    try {
      return `(enlace: ${new URL(String(v).trim()).hostname})`;
    } catch {
      return "(enlace)";
    }
  }
  const s = String(v).trim();
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/** Escanea keys de metadata en una muestra de líneas recientes (lectura). */
export async function scanMetadataKeys(
  storeId: string,
  orderLimit = 500,
): Promise<MetadataKeyInfo[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("orders")
    .select("items_json")
    .eq("store_id", storeId)
    .order("placed_at", { ascending: false })
    .limit(orderLimit);
  if (error) throw new Error(`Orders read: ${error.message}`);
  let lines = 0;
  const hits = new Map<string, { n: number; kinds: Map<string, number>; samples: string[] }>();
  for (const o of (data ?? []) as Array<Record<string, unknown>>) {
    for (const i of ((o.items_json as Array<Record<string, unknown>>) ?? [])) {
      lines += 1;
      const md = (i.metadata as Record<string, unknown> | null) ?? null;
      if (!md || typeof md !== "object") continue;
      for (const [k, v] of Object.entries(md)) {
        if (SECRET_KEY_RE.test(k)) continue;
        let h = hits.get(k);
        if (!h) {
          h = { n: 0, kinds: new Map(), samples: [] };
          hits.set(k, h);
        }
        h.n += 1;
        const kind = sampleKind(v);
        if (!kind) continue;
        h.kinds.set(kind, (h.kinds.get(kind) ?? 0) + 1);
        if (h.samples.length < 3) {
          const m = maskSample(v);
          if (m && !h.samples.includes(m)) h.samples.push(m);
        }
      }
    }
  }
  return [...hits.entries()]
    .map(([key, h]): MetadataKeyInfo => {
      const kind = [...h.kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as MetadataKeyInfo["kind"] | undefined;
      return { key, freq: lines > 0 ? Math.round((h.n / lines) * 100) : 0, kind: kind ?? "text", samples: h.samples };
    })
    .sort((a, b) => b.freq - a.freq);
}

/** Pre-llenado por forma: url con pinta de archivo, si no null honesto. */
export function suggestContentKey(keys: MetadataKeyInfo[]): string | null {
  const urls = keys.filter((k) => k.kind === "url");
  return (
    urls.find((k) => /file|media|image|img|video|adjunto|archivo/i.test(k.key))?.key ??
    urls[0]?.key ??
    null
  );
}

/** Valida forma: 0-1 key de texto. */
export function validateMetadataMap(raw: unknown): { ok: true; map: MetadataMap } | { ok: false; message: string } {
  const m = (raw as Record<string, unknown> | null) ?? {};
  // Compat: mapas viejos {file,…} → se toma file como contenido.
  const legacy = typeof m.file === "string" && m.file.trim() ? m.file.trim() : null;
  const v = m.content;
  let content: string | null = legacy;
  if (v !== undefined && v !== null && v !== "") {
    if (typeof v !== "string" || !v.trim() || v.trim().length > 120) {
      return { ok: false, message: "El contenido es una sola key de texto (máx 120)." };
    }
    content = v.trim();
  }
  const exc = Array.isArray(m.exclude) ? m.exclude : [];
  if (exc.length > 50 || exc.some((k) => typeof k !== "string" || !k.trim() || k.trim().length > 120)) {
    return { ok: false, message: "Excluidos: máx 50 keys de texto." };
  }
  const exclude = [...new Set(exc.map((k) => String(k).trim()))].filter((k) => k !== content);
  return { ok: true, map: { content, exclude } };
}

/** Lee el mapa guardado (null = sin mapear). */
export async function getMetadataMap(storeId: string): Promise<MetadataMap | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from("store_profiles")
    .select("metadata_map")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error || !data) return null;
  const v = (data as Record<string, unknown>).metadata_map as unknown;
  if (!v || typeof v !== "object") return null;
  const parsed = validateMetadataMap(v);
  return parsed.ok ? parsed.map : null;
}

/** Guarda el mapa (upsert del perfil; el sync nunca toca esta columna). */
export async function saveMetadataMap(storeId: string, raw: unknown): Promise<MetadataMap> {
  const parsed = validateMetadataMap(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  const db = getSupabase();
  const { error } = await db
    .from("store_profiles")
    .upsert({ store_id: storeId, metadata_map: parsed.map }, { onConflict: "store_id" });
  if (error) throw new Error(`Profile update: ${error.message}`);
  return parsed.map;
}

/** Resuelve keys para el lector (sin mapa = EMPTY_KEYS: sin lookup, honesto). */
export async function resolveItemKeys(storeId: string): Promise<ResolvedItemKeys> {
  const map = await getMetadataMap(storeId).catch(() => null);
  if (!map) return EMPTY_KEYS;
  return { file: map.content ?? "", exclude: map.exclude ?? [] };
}
