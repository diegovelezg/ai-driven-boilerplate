// Lecturas de customers desde Supabase (source of truth para la vista).
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { searchContentCustomerIds } from "@/lib/item-context";
import { normalizeShopUrl } from "@/lib/sync";
import { domainFromEmail } from "@/lib/domains";
import { smartTitleCase } from "@/lib/text";
import type { CanonicalCustomer } from "@/lib/medusa";
import {
  matchesDecisionFilter,
  BANDA_VALUES,
  CLOSE_WATCH_DEFAULT_P,
  DECIL_VALUES,
  ELEGIBILIDAD_VALUES,
  RITMO_VALUES,
  VENTANA_VALUES,
  isCloseWatch,
  matchesDecilFilter,
  type CustomerPredictionLite,
} from "@/lib/customer-predictions";
import {
  applyScopeFilter,
  effectiveScopeFilter,
  isEmptyScope,
  type MarketScope,
} from "@/lib/markets";

export async function resolveStoreId(medusaUrl: string): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const { data } = await getSupabase()
    .from("stores")
    .select("id")
    .eq("platform", "medusa")
    .eq("shop_url", normalizeShopUrl(medusaUrl))
    .maybeSingle();
  return (data?.id as string) ?? null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Valor efectivo: override manual ?? base Medusa ("gana lo local"). */
function eff(overrides: Record<string, unknown>, key: string, base: unknown): string | null {
  return str(overrides[key]) ?? (base as string) ?? null;
}

export type ManualField = "first_name" | "last_name" | "phone" | "company_name" | "customer_type";
export const MANUAL_FIELDS: readonly ManualField[] = [
  "first_name",
  "last_name",
  "phone",
  "company_name",
  "customer_type",
];

/** Customer listo para UI editable: valores efectivos + base Medusa + qué está overrideado. */
export interface EditableCustomer extends CanonicalCustomer {
  /** UUID de la fila en Supabase (para writes). `id` sigue siendo el external_id. */
  dbId: string;
  customerType: string;
  /** ISO2 atribuido por mercado (moda de sus órdenes). null = sin país. */
  country: string | null;
  /** companyName proviene del enriquecimiento (no de Medusa ni edición manual). */
  companyNameEnriched: boolean;
  base: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    companyName: string | null;
    customerType: string;
  };
  manualFields: ManualField[];
}

export function toEditableCustomer(
  r: Record<string, unknown>,
  enrichedByDomain: Map<string, string> = new Map(),
): EditableCustomer {
  const currency = (r.currency as string) ?? null;
  const ordersCount = Number(r.orders_count ?? 0);
  const totalSpent = Number(r.total_spent ?? 0);
  // Desglose por moneda (sync lo escribe; fallback a la primaria pre-migración).
  const rawStats = (r.stats_by_currency as Array<Record<string, unknown>> | null) ?? [];
  const totalsByCurrency = rawStats.length > 0
    ? rawStats.map((t) => ({
        currency: String(t.currency ?? ""),
        ordersCount: Number(t.ordersCount ?? 0),
        totalSpent: Number(t.totalSpent ?? 0),
      }))
    : currency
      ? [{ currency, ordersCount, totalSpent }]
      : [];
  const overrides =
    (r.manual_edits as Record<string, unknown> | null) ?? {};
  const baseCustomerType = (r.customer_type as string) ?? "B2C";
  const manualFields = MANUAL_FIELDS.filter((k) => str(overrides[k]) !== null);
  // Empresa: edición manual > Medusa > enriquecimiento (por dominio).
  const overrideCompany = str(overrides["company_name"]);
  const baseCompany = (r.company_name as string) ?? null;
  const enrichedCompany =
    enrichedByDomain.get(domainFromEmail(String(r.email ?? ""))) ?? null;
  const companyName = overrideCompany ?? baseCompany ?? enrichedCompany;
  const companyNameEnriched = !overrideCompany && !baseCompany && !!enrichedCompany;
  return {
    id: String(r.external_id ?? r.id),
    dbId: String(r.id),
    email: String(r.email ?? ""),
    firstName: smartTitleCase(eff(overrides, "first_name", r.first_name)),
    lastName: smartTitleCase(eff(overrides, "last_name", r.last_name)),
    phone: eff(overrides, "phone", r.phone),
    companyName: smartTitleCase(companyName),
    companyNameEnriched,
    customerType: eff(overrides, "customer_type", baseCustomerType) ?? "B2C",
    country: (r.country as string) ?? null,
    createdAt: (r.external_created_at as string) ?? null,
    ordersCount,
    totalSpent,
    currency,
    totalsByCurrency,
    base: {
      firstName: (r.first_name as string) ?? null,
      lastName: (r.last_name as string) ?? null,
      phone: (r.phone as string) ?? null,
      companyName: (r.company_name as string) ?? null,
      customerType: baseCustomerType,
    },
    manualFields,
  };
}

export interface DbCustomersPage {
  rows: EditableCustomer[];
  totalCount: number;
}

export type CustomersSortKey = "email" | "name" | "phone" | "company" | "orders" | "total" | "valor";
export type CustomersSortDir = "asc" | "desc";
export interface CustomersSort {
  key: CustomersSortKey;
  dir: CustomersSortDir;
}

const SORT_KEYS: readonly CustomersSortKey[] = [
  "email",
  "name",
  "phone",
  "company",
  "orders",
  "total",
  "valor",
];

/** Valida sort/dir de searchParams; default estable email/asc (orden previo). */
export function parseCustomersSort(sp: { sort?: string; dir?: string }): CustomersSort {
  const key = SORT_KEYS.includes(sp.sort as CustomersSortKey)
    ? (sp.sort as CustomersSortKey)
    : "email";
  const dir = sp.dir === "desc" ? "desc" : "asc";
  return { key, dir };
}

/** company_name enriquecido por dominio (para poblar "Empresa" si Medusa no la trae). */
async function loadEnrichedByDomain(
  db: ReturnType<typeof getSupabase>,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, string>> {
  const firms = await loadEnrichedFirmsByDomain(db, rows);
  const map = new Map<string, string>();
  for (const [domain, firm] of firms) {
    if (firm.company) map.set(domain, firm.company);
  }
  return map;
}

/** Firmográficos enriquecidos por dominio: qué es la empresa, no solo su nombre. */
interface EnrichedFirm {
  company: string | null;
  industry: string | null;
  description: string | null;
  size: string | null;
  location: string | null;
}

async function loadEnrichedFirmsByDomain(
  db: ReturnType<typeof getSupabase>,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, EnrichedFirm>> {
  const map = new Map<string, EnrichedFirm>();
  const domains = [
    ...new Set(rows.map((r) => domainFromEmail(String(r.email ?? ""))).filter(Boolean)),
  ];
  if (domains.length === 0) return map;
  const { data } = await db
    .from("domains")
    .select("domain,company_name,industry,description,size,location")
    .in("domain", domains);
  for (const d of (data ?? []) as Array<Record<string, unknown>>) {
    map.set(String(d.domain), {
      company: (d.company_name as string) ?? null,
      industry: (d.industry as string) ?? null,
      description: (d.description as string) ?? null,
      size: (d.size as string) ?? null,
      location: (d.location as string) ?? null,
    });
  }
  return map;
}

/** Dominios cuya ficha enriquecida matchea el término (nombre, industria, qué es…). */
async function searchEnrichedDomains(
  db: ReturnType<typeof getSupabase>,
  term: string,
  limit = 20,
): Promise<string[]> {
  const esc = term.replace(/[%_\\]/g, "\\$&").replace(/,/g, " ");
  if (!esc.trim()) return [];
  const like = `%${esc}%`;
  const { data } = await db
    .from("domains")
    .select("domain")
    .or(
      `company_name.ilike.${like},industry.ilike.${like},description.ilike.${like},size.ilike.${like},location.ilike.${like},domain.ilike.${like}`,
    )
    .limit(limit);
  return ((data ?? []) as Array<Record<string, unknown>>).map((d) => String(d.domain));
}

/** ¿El término matchea la ficha enriquecida (nombre, industria, descripción, sede, dominio)? */
function matchesEnrichedFirm(needle: string, firm: EnrichedFirm | undefined): boolean {
  if (!firm) return false;
  const hay = [firm.company, firm.industry, firm.description, firm.size, firm.location]
    .map((v) => String(v ?? "").toLowerCase())
    .filter(Boolean);
  return hay.some((h) => h.includes(needle));
}

export interface CustomerFilters {
  /** Decisión del motor (foto del día): actuar|vigilar|no-tocar|organico|dormido|sin_canal|contactado_reciente|revision_humana. */
  decision: string | null;
  /** Vista prearmada: "ventana7" (entra en ventana en 7d) o "seguimiento" (vigilar cercano, issue #21). */
  vista: string | null;
  /** Ritmo estructural: con-ritmo|primera|sin-compras. */
  ritmo: string | null;
  /** Tipo efectivo (manual_edits.customer_type ?? customer_type): B2B|B2C. */
  customerType: string | null;
  /** Ejes de segmentación (issue #14A): ventana|banda|elegibilidad|decil. */
  ventana: string | null;
  banda: string | null;
  elegibilidad: string | null;
  decil: string | null;
}

const NO_CUSTOMER_FILTERS: CustomerFilters = {
  decision: null,
  vista: null,
  ritmo: null,
  customerType: null,
  ventana: null,
  banda: null,
  elegibilidad: null,
  decil: null,
};

const DECISION_VALUES = new Set([
  "actuar",
  "vigilar",
  "no-tocar",
  "organico",
  "dormido",
  "sin_canal",
  "contactado_reciente",
  "revision_humana",
]);

/** Valida decision/vista/ritmo/tipo/ejes de searchParams; lo inválido se ignora. */
export function parseCustomerFilters(sp: {
  decision?: string;
  vista?: string;
  ritmo?: string;
  tipo?: string;
  customer_type?: string;
  ventana?: string;
  banda?: string;
  elegibilidad?: string;
  decil?: string;
}): CustomerFilters {
  const decision =
    sp.decision && DECISION_VALUES.has(sp.decision) ? sp.decision : null;
  const vista = sp.vista === "ventana7" || sp.vista === "seguimiento" ? sp.vista : null;
  const ritmo = sp.ritmo && RITMO_VALUES.has(sp.ritmo) ? sp.ritmo : null;
  const rawTipo = (sp.tipo ?? sp.customer_type ?? "").trim().toUpperCase();
  const customerType = rawTipo === "B2B" || rawTipo === "B2C" ? rawTipo : null;
  const ventana = sp.ventana && VENTANA_VALUES.has(sp.ventana) ? sp.ventana : null;
  const banda = sp.banda && BANDA_VALUES.has(sp.banda) ? sp.banda : null;
  const elegibilidad =
    sp.elegibilidad && ELEGIBILIDAD_VALUES.has(sp.elegibilidad) ? sp.elegibilidad : null;
  const decil = sp.decil && DECIL_VALUES.has(sp.decil) ? sp.decil : null;
  return { decision, vista, ritmo, customerType, ventana, banda, elegibilidad, decil };
}

function hasCustomerFilters(f: CustomerFilters): boolean {
  return (
    f.decision !== null ||
    f.vista !== null ||
    f.ritmo !== null ||
    f.customerType !== null ||
    f.ventana !== null ||
    f.banda !== null ||
    f.elegibilidad !== null ||
    f.decil !== null
  );
}

/** Tipo efectivo: override manual ?? base Medusa (misma regla que toEditableCustomer). */
function effectiveCustomerType(r: Record<string, unknown>): string {
  const overrides = (r.manual_edits as Record<string, unknown> | null) ?? {};
  const manual =
    typeof overrides["customer_type"] === "string" && overrides["customer_type"] !== ""
      ? (overrides["customer_type"] as string)
      : null;
  return (manual ?? (r.customer_type as string) ?? "B2C").toUpperCase() === "B2B"
    ? "B2B"
    : "B2C";
}

/** Predicción mínima para columnas/filtros (foto del día, solo lectura).
 *  Re-export client-safe: los Client Components deben importar el tipo y
 *  `ventanaLabel`/`matchesDecisionFilter` desde `lib/customer-predictions`
 *  (este módulo arrastra `server-only` vía sync). */
export type { CustomerPredictionLite } from "@/lib/customer-predictions";

/** Última predicción por cliente (una foto; pagina completo hasta CAP). */
export async function getPredictionsMap(
  storeId: string,
): Promise<Map<string, CustomerPredictionLite>> {
  const db = getSupabase();
  const map = new Map<string, CustomerPredictionLite>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db
      .from("customer_predictions")
      .select("customer_id,decision,model,valor_esperado_minor,p_recompra_h,p25_days,p75_days,evidence_json,as_of,model_version,ritmo,ventana,banda_p,valor_decil,elegibilidad")
      .eq("store_id", storeId)
      .order("as_of", { ascending: false })
      // v2 convive con v1 el día del deploy: prefiere v2 (misma foto).
      // Orden lexicográfico ("retention:v2" > "retention:v1"): si llega v10,
      // revisar (v10 > v2 pero v9 < v2 en texto).
      .order("model_version", { ascending: false })
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) return map;
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const cid = String(r.customer_id ?? "");
      if (!cid || map.has(cid)) continue;
      const ev = (r.evidence_json as Record<string, unknown> | null) ?? {};
      const model = (r.model as string | null) ?? null;
      // Ritmo: columna de ejes, fallback al modelo (fotos pre-migración).
      const ritmo =
        (r.ritmo as string | null) ??
        (model === "renovacion" ? "con-ritmo" : model === "segunda_compra" ? "primera" : null);
      map.set(cid, {
        decision: String(r.decision ?? ""),
        model,
        tDays: ev.t_days == null ? null : Number(ev.t_days),
        p25Days: r.p25_days == null ? null : Number(r.p25_days),
        p75Days: r.p75_days == null ? null : Number(r.p75_days),
        pRecompraH: r.p_recompra_h == null ? null : Number(r.p_recompra_h),
        valorEsperadoMinor:
          r.valor_esperado_minor == null ? null : Number(r.valor_esperado_minor),
        ritmo,
        ventana: (r.ventana as string | null) ?? null,
        bandaP: (r.banda_p as string | null) ?? null,
        valorDecil: r.valor_decil == null ? null : Number(r.valor_decil),
        elegibilidad: (r.elegibilidad as string | null) ?? null,
      });
    }
    if (rows.length < 1000) break;
    if (off >= 30000) break;
    }
  return map;
}

/** ¿La predicción calza con el filtro `decision`? Ver `lib/customer-predictions`. */

/** Etiqueta de ventana desde t y p25/p75. Ver `lib/customer-predictions`. */

/** Resumen "entran en ventana en 7 días" (vigilar con p25−t ∈ [0,7]). */
export async function getVentana7Summary(
  storeId: string,
): Promise<{ n: number; sumaMinor: number }> {
  const map = await getPredictionsMap(storeId).catch(
    () => new Map<string, CustomerPredictionLite>(),
  );
  let n = 0;
  let sumaMinor = 0;
  for (const p of map.values()) {
    if (p.decision !== "vigilar" || p.tDays === null || p.p25Days === null) continue;
    const diff = p.p25Days - p.tDays;
    if (diff >= 0 && diff <= 7) {
      n += 1;
      sumaMinor += p.valorEsperadoMinor ?? 0;
    }
  }
  return { n, sumaMinor };
}

/** Resumen "seguimiento cercano" (issue #21 Paso 2): misma definición que
 *  el héroe (vigilar AND (recuperable OR p>=corte)). Solo display. */
export async function getSeguimientoSummary(
  storeId: string,
  cutoff: number = CLOSE_WATCH_DEFAULT_P,
): Promise<{ n: number; sumaMinor: number }> {
  const map = await getPredictionsMap(storeId).catch(
    () => new Map<string, CustomerPredictionLite>(),
  );
  let n = 0;
  let sumaMinor = 0;
  for (const p of map.values()) {
    if (!isCloseWatch(p, cutoff)) continue;
    n += 1;
    sumaMinor += p.valorEsperadoMinor ?? 0;
  }
  return { n, sumaMinor };
}

/** Ritmo de un cliente para filtro: del modelo, o sin-compras si no hay
 *  predicción y nunca compró. Clientes con compras pero sin predicción
 *  (alta posterior a la corrida) no calzan en ningún ritmo. */
function matchesRitmoFilter(
  pred: CustomerPredictionLite | undefined,
  ordersCount: number,
  filter: string,
): boolean {
  // Columna de ejes primero (fotos nuevas); fallback al modelo (pre-migración).
  if (pred?.ritmo) return pred.ritmo === filter;
  if (filter === "con-ritmo") return pred?.model === "renovacion";
  if (filter === "primera") return pred?.model === "segunda_compra";
  if (filter === "sin-compras") return !pred && ordersCount === 0;
  return false;
}

/** En juego mensual desde el motor (issue #12): por cada fin de mes, la foto
 *  de predicciones más cercana sin pasarlo; Σ valor esperado de
 *  actuar+revisión+vigilar en la moneda de la vista. Sin foto para un mes
 *  (el motor aún no corría), el mes queda fuera del mapa y la serie usa
 *  reconstrucción pre-motor etiquetada. Sin leakage: nunca fotos futuras. */
export async function getPredEnJuegoByMonth(
  storeId: string,
  monthEnds: Array<{ key: string; endMs: number }>,
  viewCurrency: string | null,
): Promise<Map<string, { minor: number; count: number }>> {
  const out = new Map<string, { minor: number; count: number }>();
  if (monthEnds.length === 0) return out;
  const db = getSupabase();
  const maxEnd = Math.max(...monthEnds.map((m) => m.endMs));
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 5000) {
    const { data, error } = await db
      .from("customer_predictions")
      .select("as_of,customer_id,decision,valor_esperado_minor,currency,model_version")
      .eq("store_id", storeId)
      .lte("as_of", new Date(maxEnd).toISOString())
      .order("as_of", { ascending: false })
      .order("model_version", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + 4999);
    if (error) return out;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) rows.push(r);
    if (!data || data.length < 5000) break;
    if (from > 30000) break;
  }
  // Agrupar por fecha de foto (desc) y caminar los fines de mes (desc).
  const byPhoto = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const k = String(r.as_of ?? "");
    if (!k) continue;
    const list = byPhoto.get(k) ?? [];
    list.push(r);
    byPhoto.set(k, list);
  }
  const photoDates = [...byPhoto.keys()].sort().reverse();
  const endsDesc = [...monthEnds].sort((a, b) => b.endMs - a.endMs);
  let pi = 0;
  for (const m of endsDesc) {
    while (pi < photoDates.length && Date.parse(photoDates[pi]) > m.endMs) pi += 1;
    if (pi >= photoDates.length) continue;
    const photo = byPhoto.get(photoDates[pi]) ?? [];
    // v1+v2 conviven el día del deploy: un cliente, un voto (prefiere v2).
    const seen = new Set<string>();
    let minor = 0;
    let count = 0;
    for (const r of photo) {
      const cid = String(r.customer_id ?? "");
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const d = String(r.decision ?? "");
      if (d !== "actuar" && d !== "revision_humana" && d !== "vigilar") continue;
      const cur = (r.currency as string | null) ?? null;
      if (viewCurrency !== null && cur !== null && cur.toUpperCase() !== viewCurrency.toUpperCase()) continue;
      const v = r.valor_esperado_minor == null ? null : Number(r.valor_esperado_minor);
      if (v === null) continue;
      minor += v;
      count += 1;
    }
    if (count > 0) out.set(m.key, { minor, count });
  }
  return out;
}

/** Facturación bruta acumulada por tipo efectivo (issue #14A: "¿qué tipo de
 *  cliente vale más?"). Escaneo con CAP (mismo patrón que las fotos del
 *  motor): si se capa, `truncated=true` y las cifras son parciales. Solo
 *  suma filas en `currency` (moneda de la vista); el resto se ignora y se
 *  cuenta en `otherCurrency` para rotularlo. */
export async function getValorByType(
  storeId: string,
  currency: string | null,
  market: MarketScope | null = null,
): Promise<{
  b2b: { n: number; minor: number };
  b2c: { n: number; minor: number };
  otherCurrency: number;
  truncated: boolean;
}> {
  const out = {
    b2b: { n: 0, minor: 0 },
    b2c: { n: 0, minor: 0 },
    otherCurrency: 0,
    truncated: false,
  };
  const db = getSupabase();
  const inMarket = (r: Record<string, unknown>): boolean => {
    if (!market || (!market.countries && !market.customerIds)) return true;
    if (isEmptyScope(market)) return r.country == null;
    const { countries, ids } = effectiveScopeFilter(market);
    if (countries) return r.country == null || countries.includes(String(r.country));
    if (ids) return r.country == null || ids.includes(String(r.id));
    return true;
  };
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db
      .from("customers")
      .select("id,country,orders_count,total_spent,currency,customer_type,manual_edits")
      .eq("store_id", storeId)
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) return out;
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (!inMarket(r)) continue;
      const overrides = (r.manual_edits as Record<string, unknown> | null) ?? {};
      const manual =
        typeof overrides["customer_type"] === "string" && overrides["customer_type"] !== ""
          ? String(overrides["customer_type"]).toUpperCase()
          : null;
      const tipo = (manual ?? String(r.customer_type ?? "B2C")).toUpperCase() === "B2B" ? "b2b" : "b2c";
      const cur = (r.currency as string | null) ?? null;
      if (currency !== null && cur !== null && cur.toUpperCase() !== currency.toUpperCase()) {
        out.otherCurrency += 1;
        continue;
      }
      out[tipo].n += 1;
      out[tipo].minor += Number(r.total_spent ?? 0);
    }
    if (rows.length < 1000) break;
    if (off >= 29000) {
      out.truncated = true;
      break;
    }
  }
  return out;
}

export async function queryStoreCustomers(
  storeId: string,
  q: string,
  page: number,
  pageSize: number,
  sort: CustomersSort = { key: "email", dir: "asc" },
  filters: CustomerFilters = NO_CUSTOMER_FILTERS,
  // Filtro global por mercado (null = todos). Por ISO2 (corto); IDs solo en
  // el fallback sin países (ver resolveMarketScope en lib/markets).
  // NULL-comodín: los sin país (r.country null) pasan cualquier filtro.
  market: MarketScope | null = null,
  // Corte p de "seguimiento cercano" por tenant (issue #21). Null = default
  // 0.10; los callers pasan el valor resuelto vía resolveCloseWatchP.
  // Solo display.
  closeWatchCutoff: number | null = null,
): Promise<DbCustomersPage> {
  // Predicado JS (misma semántica que applyScopeFilter) para los caminos
  // que resuelven en memoria. NULL-comodín: sin país pasa todo filtro.
  const inMarket = (r: Record<string, unknown>): boolean => {
    if (!market || (!market.countries && !market.customerIds)) return true;
    if (isEmptyScope(market)) return r.country == null;
    const { countries, ids } = effectiveScopeFilter(market);
    if (countries) return r.country == null || countries.includes(String(r.country));
    if (ids) return r.country == null || ids.includes(String(r.id));
    return true;
  };
  const db = getSupabase();
  const from = (page - 1) * pageSize;
  const ascending = sort.dir === "asc";
  const term = q.trim();
  const like = term ? `%${term.replace(/[%_\\]/g, "\\$&").replace(/,/g, " ")}%` : null;
  // Búsqueda en customers + empresa efectiva (Medusa) + empresa enriquecida
  // (qué es: nombre, industria, descripción…). Lo enriquecido vive en `domains`
  // (global, por dominio): se resuelve a dominios y se filtra por email.
  const enrichedDomains = like ? await searchEnrichedDomains(db, term).catch(() => []) : [];
  const enrichedEmailOr = enrichedDomains
    .map((d) => `email.ilike.%@${d}%`)
    .join(",");
  // Contenido Nivel 1 (marca/categoría/qué) → customer ids.
  const contentIds = like ? await searchContentCustomerIds(storeId, term).catch(() => new Map()) : new Map();
  const contentIdOr = contentIds.size > 0 ? `,id.in.(${[...contentIds.keys()].join(",")})` : "";
  const searchOr = like
    ? `email.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},phone.ilike.${like},company_name.ilike.${like}${enrichedEmailOr ? `,${enrichedEmailOr}` : ""}${contentIdOr}`
    : null;

  // Con filtros de decisión o sort por valor se resuelve en JS sobre la
  // población completa (misma cohorte de mercado que el resto de la vista).
  if (hasCustomerFilters(filters) || sort.key === "valor") {
    const all: Array<Record<string, unknown>> = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await db
        .from("customers")
        .select("*")
        .eq("store_id", storeId)
        .order("id", { ascending: true })
        .range(off, off + 999);
      if (error) throw new Error(`DB read: ${error.message}`);
      all.push(...((data as Array<Record<string, unknown>>) ?? []));
      if (!data || data.length < 1000) break;
    }
    const scoped = all.filter(inMarket);
    const firms = await loadEnrichedFirmsByDomain(db, scoped);
    const enriched = new Map<string, string>();
    // Foto del día para filtro/sort del motor (una sola query, sin N+1).
    const needPred =
      filters.decision !== null ||
      filters.vista !== null ||
      filters.ritmo !== null ||
      filters.ventana !== null ||
      filters.banda !== null ||
      filters.elegibilidad !== null ||
      filters.decil !== null ||
      sort.key === "valor";
    const predMap = needPred ? await getPredictionsMap(storeId).catch(() => new Map()) : new Map<string, CustomerPredictionLite>();
    for (const [domain, firm] of firms) {
      if (firm.company) enriched.set(domain, firm.company);
    }
    const needle = term.toLowerCase();
    const matched: EditableCustomer[] = [];
    scoped.forEach((r) => {
      const pred = predMap.get(String(r.id ?? ""));
      if (filters.customerType !== null && effectiveCustomerType(r) !== filters.customerType) return;
      if (filters.decision !== null && !matchesDecisionFilter(pred, filters.decision)) return;
      if (filters.ventana !== null && (pred?.ventana ?? null) !== filters.ventana) return;
      if (filters.banda !== null && (pred?.bandaP ?? null) !== filters.banda) return;
      if (filters.elegibilidad !== null && (pred?.elegibilidad ?? null) !== filters.elegibilidad) return;
      if (filters.decil !== null && !matchesDecilFilter(pred?.valorDecil ?? null, filters.decil)) return;
      if (filters.ritmo !== null) {
        const oc = Number(r.orders_count ?? 0);
        if (!matchesRitmoFilter(pred, oc, filters.ritmo)) return;
      }
      if (filters.vista === "ventana7") {
        if (!pred || pred.decision !== "vigilar" || pred.tDays === null || pred.p25Days === null) return;
        const diff = pred.p25Days - pred.tDays;
        if (diff < 0 || diff > 7) return;
      }
      if (filters.vista === "seguimiento") {
        let cutoff = closeWatchCutoff;
        if (cutoff === null || cutoff === undefined) cutoff = CLOSE_WATCH_DEFAULT_P;
        if (!isCloseWatch(pred, cutoff)) return;
      }
      if (needle) {
        const overrides = (r.manual_edits as Record<string, unknown> | null) ?? {};
        const domain = domainFromEmail(String(r.email ?? ""));
        const hay = [
          r.email,
          r.first_name,
          r.last_name,
          r.phone,
          r.company_name,
          overrides["company_name"],
        ].map((v) => String(v ?? "").toLowerCase());
        if (
          !hay.some((h) => h.includes(needle)) &&
          !matchesEnrichedFirm(needle, firms.get(domain)) &&
          !contentIds.has(String(r.id))
        )
          return;
      }
      matched.push(toEditableCustomer(r, enriched));
    });
    const dir = ascending ? 1 : -1;
    matched.sort((a, b) => {
      // Desempate estable por email asc (igual que en SQL).
      const emailTie = a.email.localeCompare(b.email, "es", { sensitivity: "base" });
      switch (sort.key) {
        case "name": {
          const an = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim();
          const bn = `${b.firstName ?? ""} ${b.lastName ?? ""}`.trim();
          return dir * an.localeCompare(bn, "es", { sensitivity: "base" }) || emailTie;
        }
        case "phone":
          return (
            dir * (a.phone ?? "").localeCompare(b.phone ?? "", "es", { sensitivity: "base" }) ||
            emailTie
          );
        case "company": {
          const av = (a.companyName ?? "").trim();
          const bv = (b.companyName ?? "").trim();
          if (!av && !bv) return emailTie;
          if (!av) return 1; // vacíos al final
          if (!bv) return -1;
          return dir * av.localeCompare(bv, "es", { sensitivity: "base" }) || emailTie;
        }
        case "orders":
          return dir * (a.ordersCount - b.ordersCount) || emailTie;
        case "total":
          return dir * (a.totalSpent - b.totalSpent) || emailTie;
        case "valor": {
          const av = predMap.get(a.dbId)?.valorEsperadoMinor ?? null;
          const bv = predMap.get(b.dbId)?.valorEsperadoMinor ?? null;
          if (av === null && bv === null) return emailTie;
          if (av === null) return 1;
          if (bv === null) return -1;
          return dir * (av - bv) || emailTie;
        }
        default:
          return dir * emailTie;
      }
    });
    return { rows: matched.slice(from, from + pageSize), totalCount: matched.length };
  }

  // "Empresa" se ordena por el nombre EFECTIVO (manual > Medusa > enriquecido),
  // que puede venir del enriquecimiento por dominio → se resuelve en JS.
  if (sort.key === "company") {
    const all: Array<Record<string, unknown>> = [];
    for (let off = 0; ; off += 1000) {
      let bq = db.from("customers").select("*").eq("store_id", storeId).order("id", { ascending: true });
      if (like && searchOr) bq = bq.or(searchOr);
      const { data, error } = await bq.range(off, off + 999);
      if (error) throw new Error(`DB read: ${error.message}`);
      all.push(...((data as Array<Record<string, unknown>>) ?? []));
      if (!data || data.length < 1000) break;
    }
    const enriched = await loadEnrichedByDomain(db, all);
    const rows = all.filter(inMarket).map((r) => toEditableCustomer(r, enriched));
    rows.sort((a, b) => {
      const av = (a.companyName ?? "").trim();
      const bv = (b.companyName ?? "").trim();
      if (!av && !bv) return 0;
      if (!av) return 1; // vacíos al final
      if (!bv) return -1;
      const c = av.localeCompare(bv, "es", { sensitivity: "base" });
      return ascending ? c : -c;
    });
    return { rows: rows.slice(from, from + pageSize), totalCount: rows.length };
  }

  let query = applyScopeFilter(
    db.from("customers").select("*", { count: "exact" }).eq("store_id", storeId),
    market,
    "id",
  );
  switch (sort.key) {
    case "email":
      query = query.order("email", { ascending });
      break;
    case "name":
      query = query
        .order("first_name", { ascending })
        .order("last_name", { ascending });
      break;
    case "phone":
      query = query.order("phone", { ascending });
      break;
    case "orders":
      query = query.order("orders_count", { ascending });
      break;
    case "total":
      query = query.order("total_spent", { ascending });
      break;
  }
  // Desempate estable para paginar sin filas duplicadas/ausentes.
  // Email no es único (hay duplicados por email): el tie-breaker final es
  // siempre la PK `id` (toda cadena con .range la lleva).
  if (sort.key !== "email") query = query.order("email", { ascending: true });
  query = query.order("id", { ascending: true });
  if (like && searchOr) query = query.or(searchOr);
  const { data, count, error } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(`DB read: ${error.message}`);

  const raw = (data as Array<Record<string, unknown>>) ?? [];
  const enrichedByDomain = await loadEnrichedByDomain(db, raw);
  return {
    rows: raw.map((r) => toEditableCustomer(r, enrichedByDomain)),
    totalCount: count ?? 0,
  };
}
