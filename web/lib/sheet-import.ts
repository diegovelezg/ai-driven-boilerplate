// Importación DOOH desde Google Sheet URL o CSV.
// Pivote: solo Sheet/CSV. Empresas (agencia/anunciante/proveedor), contactos e
// inventario (propio o de proveedor) se importan desde Sheet/CSV.
// Módulo puro (sin BD): parse + normalización + validación. Testeable con tsx --test.
import type { CompanyKind } from "@/lib/crm";

export type ImportKind = "companies" | "contacts" | "venues" | "screens" | "slots";

export interface ImportRowError {
  row: number; // 1-based en el CSV (incluye header)
  message: string;
}

/** Convierte una URL de Google Sheets en URL CSV exportable. No-URL → null. */
export function sheetUrlToCsvUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const m = t.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)(?:.*?[?&#]gid=(\d+))?/);
  if (!m) return null;
  const id = m[1];
  const gid = m[2] ?? t.match(/[#?&]gid=(\d+)/)?.[1] ?? "0";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

/** ¿Es una URL de Google Sheets (cualquier forma)? */
export function isGoogleSheetUrl(input: string): boolean {
  return /docs\.google\.com\/spreadsheets\/d\//.test(input.trim());
}

/** Parser CSV mínimo pero correcto: comillas, comas, \n dentro de comillas, "" escaped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const push = () => {
    row.push(field);
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") push();
      else if (c === "\r") { /* skip, \n cierra */ }
      else if (c === "\n") {
        push();
        rows.push(row);
        row = [];
      } else field += c;
    }
  }
  push();
  rows.push(row);
  // Quita filas totalmente vacías (trailing newline típico).
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function headerIndex(header: string[]): Map<string, number> {
  const m = new Map<string, number>();
  header.forEach((h, i) => {
    const k = h.trim().toLowerCase();
    if (k && !m.has(k)) m.set(k, i);
  });
  return m;
}

function cell(row: string[], idx: Map<string, number>, ...names: string[]): string {
  for (const n of names) {
    const i = idx.get(n);
    if (i !== undefined) return (row[i] ?? "").trim();
  }
  return "";
}

// --- Normalizadores por kind (retornan value + error fila) ---

export interface CompanyRow {
  name: string;
  tax_id: string | null;
  domain: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  kind: CompanyKind | null;
  external_ref: string | null;
}

export function normalizeCompanyRow(
  row: string[],
  idx: Map<string, number>,
): { ok: true; value: CompanyRow } | { ok: false; error: string } {
  const name = cell(row, idx, "name", "nombre", "empresa");
  if (!name) return { ok: false, error: "name requerido" };
  if (name.length > 200) return { ok: false, error: "name máx 200" };
  const kindRaw = cell(row, idx, "kind", "tipo", "type").toLowerCase().trim();
  const kind: CompanyKind | null = kindRaw === "agencia" || kindRaw === "anunciante" || kindRaw === "proveedor" ? kindRaw : null;
  if (kind === null) {
    return { ok: false, error: kindRaw === "" ? "tipo requerido (agencia|anunciante|proveedor)" : `tipo inválido: ${kindRaw} (agencia|anunciante|proveedor)` };
  }
  return {
    ok: true,
    value: {
      name,
      tax_id: cell(row, idx, "tax_id", "taxid", "tax id", "id_fiscal", "id fiscal", "id-fiscal") || null,
      domain: cell(row, idx, "domain", "dominio") || null,
      email: cell(row, idx, "email", "correo") || null,
      phone: cell(row, idx, "phone", "telefono", "teléfono") || null,
      city: cell(row, idx, "city", "ciudad") || null,
      country: (cell(row, idx, "country", "pais", "país") || null)?.toUpperCase() ?? null,
      kind,
      external_ref: cell(row, idx, "external_ref", "ref", "id_externo") || null,
    },
  };
}

export interface ContactRow {
  company_ref: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  is_primary: boolean;
}

export function normalizeContactRow(
  row: string[],
  idx: Map<string, number>,
): { ok: true; value: ContactRow } | { ok: false; error: string } {
  const email = cell(row, idx, "email", "correo") || null;
  const phone = cell(row, idx, "phone", "telefono", "teléfono") || null;
  if (!email && !phone) return { ok: false, error: "email o phone requerido" };
  const company_ref =
    cell(row, idx, "company_ref", "company", "empresa", "empresa_ref") || "";
  if (!company_ref) return { ok: false, error: "company_ref requerido (nombre o external_ref)" };
  const prim = cell(row, idx, "is_primary", "principal").toLowerCase();
  return {
    ok: true,
    value: {
      company_ref,
      first_name: cell(row, idx, "first_name", "nombre") || null,
      last_name: cell(row, idx, "last_name", "apellido", "apellidos") || null,
      email,
      phone,
      job_title: cell(row, idx, "job_title", "cargo", "puesto") || null,
      is_primary: ["true", "1", "si", "sí", "yes", "x"].includes(prim),
    },
  };
}

export interface VenueRow {
  name: string;
  venue_type: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  country: string | null;
  timezone: string | null;
  ownership: "own" | "supplier";
  supplier_ref: string | null;
  external_ref: string | null;
}

const VENUE_TYPES = new Set([
  "mall",
  "transit",
  "street_furniture",
  "airport",
  "retail",
  "office",
  "residential",
  "entertainment",
  "health",
  "education",
  "other",
]);

export function normalizeVenueRow(
  row: string[],
  idx: Map<string, number>,
): { ok: true; value: VenueRow } | { ok: false; error: string } {
  const name = cell(row, idx, "name", "nombre", "venue", "local");
  if (!name) return { ok: false, error: "name requerido" };
  const vt = cell(row, idx, "venue_type", "tipo", "type").toLowerCase() || null;
  if (vt && !VENUE_TYPES.has(vt)) return { ok: false, error: `venue_type inválido: ${vt}` };
  const latRaw = cell(row, idx, "latitude", "lat", "latitud");
  const lonRaw = cell(row, idx, "longitude", "lon", "lng", "longitud");
  const latitude = latRaw ? Number(latRaw) : null;
  const longitude = lonRaw ? Number(lonRaw) : null;
  if (latRaw && !Number.isFinite(latitude)) return { ok: false, error: "latitude inválida" };
  if (lonRaw && !Number.isFinite(longitude)) return { ok: false, error: "longitude inválida" };
  const ownership = (cell(row, idx, "ownership", "propiedad").toLowerCase() || "own") as string;
  if (ownership !== "own" && ownership !== "supplier")
    return { ok: false, error: "ownership debe ser own|supplier" };
  const supplier_ref = cell(row, idx, "supplier_ref", "proveedor", "supplier") || null;
  if (ownership === "supplier" && !supplier_ref)
    return { ok: false, error: "supplier_ref requerido si ownership=supplier" };
  return {
    ok: true,
    value: {
      name,
      venue_type: vt,
      latitude,
      longitude,
      city: cell(row, idx, "city", "ciudad") || null,
      country: (cell(row, idx, "country", "pais", "país") || null)?.toUpperCase() ?? null,
      timezone: cell(row, idx, "timezone", "zona_horaria") || null,
      ownership: ownership as "own" | "supplier",
      supplier_ref,
      external_ref: cell(row, idx, "external_ref", "ref", "id_externo") || null,
    },
  };
}

export interface ScreenRow {
  venue_ref: string;
  name: string;
  width_px: number | null;
  height_px: number | null;
  orientation: string | null;
  technology: string | null;
  placement: string | null;
  player_id: string | null;
  ownership: "own" | "supplier";
  supplier_ref: string | null;
  loop_duration_ms: number | null;
  loop_slots: number | null;
  slot_duration_ms: number | null;
  external_ref: string | null;
}

export function normalizeScreenRow(
  row: string[],
  idx: Map<string, number>,
): { ok: true; value: ScreenRow } | { ok: false; error: string } {
  const venue_ref = cell(row, idx, "venue_ref", "venue", "local", "recinto") || "";
  if (!venue_ref) return { ok: false, error: "venue_ref requerido" };
  const name = cell(row, idx, "name", "nombre", "pantalla") || "";
  if (!name) return { ok: false, error: "name requerido" };
  const w = cell(row, idx, "width_px", "w", "ancho_px");
  const h = cell(row, idx, "height_px", "h", "alto_px");
  const width_px = w ? Number(w) : null;
  const height_px = h ? Number(h) : null;
  if (w && (!Number.isFinite(width_px) || width_px! <= 0)) return { ok: false, error: "width_px inválido" };
  if (h && (!Number.isFinite(height_px) || height_px! <= 0)) return { ok: false, error: "height_px inválido" };
  const orientation = cell(row, idx, "orientation", "orientacion", "orientación").toLowerCase() || null;
  if (orientation && !["landscape", "portrait", "square"].includes(orientation))
    return { ok: false, error: "orientation debe ser landscape|portrait|square" };
  const placement = cell(row, idx, "placement", "fijo_movil", "fixed_moving").toLowerCase() || null;
  if (placement && !["fixed", "moving"].includes(placement))
    return { ok: false, error: "placement debe ser fixed|moving" };
  const loop_duration_ms = cell(row, idx, "loop_duration_ms", "loop_ms", "bucle_ms")
    ? Number(cell(row, idx, "loop_duration_ms", "loop_ms", "bucle_ms"))
    : null;
  const loop_slots = cell(row, idx, "loop_slots", "max_slots", "slots") ? Number(cell(row, idx, "loop_slots", "max_slots", "slots")) : null;
  const slot_duration_ms = cell(row, idx, "slot_duration_ms", "slot_ms") ? Number(cell(row, idx, "slot_duration_ms", "slot_ms")) : null;
  if (loop_duration_ms !== null && loop_slots !== null && slot_duration_ms !== null) {
    if (loop_duration_ms !== loop_slots * slot_duration_ms)
      return { ok: false, error: "loop inconsistente: duration_ms debe ser max_slots × slot_duration_ms" };
  }
  return {
    ok: true,
    value: {
      venue_ref,
      name,
      width_px,
      height_px,
      orientation,
      technology: cell(row, idx, "technology", "tecnologia", "tecnología") || null,
      placement,
      player_id: cell(row, idx, "player_id", "player") || null,
      ownership: ((cell(row, idx, "ownership", "propiedad").toLowerCase() || "own") as "own" | "supplier"),
      supplier_ref: cell(row, idx, "supplier_ref", "proveedor", "supplier") || null,
      loop_duration_ms,
      loop_slots,
      slot_duration_ms,
      external_ref: cell(row, idx, "external_ref", "ref", "id_externo") || null,
    },
  };
}

/** Plantillas CSV de ejemplo por kind (header + 1 fila). */
const IMPORT_TEMPLATES: Record<ImportKind, string> = {
  companies:
    "name,tax_id,domain,email,phone,city,country,roles,external_ref\nAcme SAC,20123456789,acme.pe,contacto@acme.pe,+51999999999,Lima,PE,customer,acme-001",
  contacts:
    "company_ref,first_name,last_name,email,phone,job_title,is_primary\nacme-001,Ana,Quispe,ana@acme.pe,+51999999999,Marketing,true",
  venues:
    "name,venue_type,latitude,longitude,city,country,timezone,ownership,supplier_ref,external_ref\nReal Plaza Cusco,mall,-13.52,-71.97,Cusco,PE,America/Lima,own,,rp-cusco",
  screens:
    "venue_ref,name,width_px,height_px,orientation,technology,placement,player_id,ownership,loop_duration_ms,loop_slots,slot_duration_ms,external_ref\nrp-cusco,LED Fachada,1920,1080,landscape,LED,fixed,player-01,own,60000,6,10000,scr-001",
  slots:
    "screen_ref,slot_index,share_of_voice,programmatic\nscr-001,1,16.67,false",
};

/** Valida un CSV completo y devuelve filas buenas + errores. */
export function validateImportCsv(
  kind: ImportKind,
  text: string,
): { header: string[]; ok: number; errors: ImportRowError[]; total: number } {
  const rows = parseCsv(text);
  if (rows.length === 0) return { header: [], ok: 0, errors: [{ row: 1, message: "CSV vacío" }], total: 0 };
  const idx = headerIndex(rows[0]);
  const errors: ImportRowError[] = [];
  let ok = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    let res: { ok: boolean; error?: string } = { ok: true };
    if (kind === "companies") res = normalizeCompanyRow(r, idx);
    else if (kind === "contacts") res = normalizeContactRow(r, idx);
    else if (kind === "venues") res = normalizeVenueRow(r, idx);
    else if (kind === "screens") res = normalizeScreenRow(r, idx);
    else {
      // slots: screen_ref + slot_index
      const ref = cell(r, idx, "screen_ref", "screen", "pantalla");
      const si = Number(cell(r, idx, "slot_index", "slot", "posicion", "posición"));
      res = !ref
        ? { ok: false, error: "screen_ref requerido" }
        : !Number.isInteger(si) || si < 1
          ? { ok: false, error: "slot_index debe ser entero ≥ 1" }
          : { ok: true };
    }
    if (res.ok) ok++;
    else errors.push({ row: i + 1, message: (res as { error: string }).error });
  }
  return { header: rows[0], ok, errors, total: rows.length - 1 };
}
