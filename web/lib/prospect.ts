// Lead stream (prospector, Fase B): ICP manual → queries LLM → SearXNG →
// scrape (Crawlee Cheerio) → score LLM vs ICP → proposed_leads PENDING_REVIEW.
// El prospector propone; nunca contacta solo.
import { getSupabase } from "@/lib/supabase";
import { modeCountry } from "@/lib/canonical";
import { classifyDomain, domainFromEmail } from "@/lib/domains";
import { getLlmConfig } from "@/lib/ai/llm-config";
import {
  buildQueries,
  completeJson,
  hostOf,
  pickLeadContact,
  sanitizeLeadContact,
  scrapeCandidates,
  scrapable,
  searchSearxng,
  type Scraped,
  type SearchHit,
} from "@/lib/retrieval";
import { advanceRun, finishRun, type RunStatus, formatRunError } from "@/lib/background";
import { formatMoney, formatNumber } from "@/lib/format";
import { createLogger } from "@/lib/log";

const log = createLogger("prospect");

/** Versión del criterio prospector. Sube cuando cambia scoring/retrieval. */
const PROSPECT_GEN = "prospect:v7:single-country";

/** Scope de prospección (deprecated, single-país: siempre null).
 *  Se conserva el tipo por compatibilidad; el prospector opera sobre toda
 *  la tienda (un solo país/moneda). */
export interface ProspectScope {
  countries: string[] | null;
  customerIds: string[] | null;
}

/** Nombre legible para geo en queries (PE→Perú). */
function countryName(iso: string): string {
  const m: Record<string, string> = { PE: "Perú", MX: "México", EC: "Ecuador", CO: "Colombia", CL: "Chile", AR: "Argentina", ES: "España", US: "Estados Unidos" };
  return m[iso.toUpperCase()] ?? iso.toUpperCase();
}

/** ¿El row de top-compradores pertenece al scope? NULL-comodín: sin país pasa. */
function inScope(
  r: { country?: unknown; id?: unknown },
  scope: ProspectScope | null | undefined,
): boolean {
  if (!scope) return true;
  if (scope.countries && scope.countries.length > 0) {
    const c = String(r.country ?? "").trim().toUpperCase();
    if (!c) return true;
    return scope.countries.map((x) => x.toUpperCase()).includes(c);
  }
  if (scope.customerIds && scope.customerIds.length > 0) {
    return scope.customerIds.includes(String(r.id ?? ""));
  }
  return true;
}

export interface ProspectEligibility {
  eligible: boolean;
  reason: string | null;
}

/**
 * Elegibilidad del prospector (B2B-only): siempre aplica si hay base
 * enriquecible (>=3 dominios). Sin base, se reporta "sin-base".
 */
export async function prospectEligibility(storeId: string): Promise<ProspectEligibility> {
  const db = getSupabase();
  try {
    const { data } = await db
      .from("customers")
      .select("email")
      .eq("store_id", storeId)
      .gt("orders_count", 0)
      .order("total_spent", { ascending: false })
      .limit(60);
    const rows = ((data ?? []) as Array<Record<string, unknown>>).slice(0, 20);
    const doms = new Set(
      rows.map((r) => domainFromEmail(String(r.email ?? ""))).filter((d) => d && classifyDomain(d).enrichable),
    );
    if (doms.size >= 3) return { eligible: true, reason: null };
    return { eligible: false, reason: "sin-base" };
  } catch {
    return { eligible: false, reason: "sin-base" };
  }
}

export interface Icp {
  text: string;
  manual: boolean;
}

/** ICP V1 manual + auto-derivado: si no hay icp_description, se construye desde
 *  los mejores compradores (top gasto) + firmográficos + perfil + brain (#25:
 *  top_productos/categorías del TenantBrain, 1 query). Así el prospector deja
 *  de dar 0 sin intervención manual. Con scope, el top se filtra al mercado. */
export async function getIcp(storeId: string, scope?: ProspectScope | null): Promise<Icp> {
  const { data, error } = await getSupabase()
    .from("store_profiles")
    .select("business_model,industry,description,icp_description,vertical_detected,buyer_type")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(`ICP read: ${error.message}`);
  const p = (data ?? {}) as Record<string, unknown>;
  if (typeof p.icp_description === "string" && p.icp_description.trim()) {
    return { text: p.icp_description.trim(), manual: true };
  }
  // Auto-ICP desde evidencia: no exige nada manual.
  try {
    const auto = await buildAutoIcp(storeId, p, scope);
    if (auto) return { text: auto, manual: false };
  } catch {
    // cae al perfil plano
  }
  const parts = [
    typeof p.description === "string" ? p.description.trim() : "",
    typeof p.industry === "string" ? `Industria: ${p.industry}` : "",
    typeof p.business_model === "string" ? `Modelo: ${p.business_model}` : "",
  ].filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Sin ICP: define store_profiles.icp_description (qué cliente ideal buscar) antes de prospectar.");
  }
  return { text: parts.join("\n"), manual: false };
}

/** Top compradores → industrias/tipos dominantes → texto ICP. null si sin base.
 *  V2 (TX rico): suma marcas/categorías que anuncian, vocabulario del cliente,
 *  lo que más repite, ticket p50/p80, país moda y ejemplos aprobados/rechazados.
 *  Con scope, el top se filtra al mercado activo (segmentación). */
async function buildAutoIcp(storeId: string, profile?: Record<string, unknown>, scope?: ProspectScope | null): Promise<string | null> {
  const db = getSupabase();
  const { data: top, error } = await db
    .from("customers")
    .select("id,email,customer_type,orders_count,total_spent,country,currency")
    .eq("store_id", storeId)
    .gt("orders_count", 0)
    .order("total_spent", { ascending: false })
    .limit(60);
  if (error || !top) return null;
  const allRows = top as Array<Record<string, unknown>>;
  const rows = allRows.filter((r) => inScope({ country: r.country, id: r.id }, scope)).slice(0, 20);
  if (rows.length < 3) return null;
  const b2b = rows.filter((r) => String(r.customer_type ?? "") === "B2B").length;
  // Mediana en la moneda dominante (nunca mezclar PEN+MXN en un promedio).
  const curVotes = new Map<string, number>();
  for (const r of rows) {
    const c = String(r.currency ?? "").trim().toUpperCase();
    if (c) curVotes.set(c, (curVotes.get(c) ?? 0) + 1);
  }
  const topCur = [...curVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const tickets = rows
    .filter((r) => !topCur || String(r.currency ?? "").toUpperCase() === topCur)
    .map((r) => Number(r.total_spent ?? 0) / Math.max(1, Number(r.orders_count ?? 1)))
    .sort((a, b) => a - b);
  const medianMinor = tickets.length > 0 ? tickets[Math.floor(tickets.length / 2)] : 0;
  const medianTxt = formatMoney(Math.round(medianMinor), topCur);
  // País moda de los top (el lead hereda geografía, no TLD).
  const countryVotes = new Map<string, number>();
  for (const r of rows) {
    const c = String(r.country ?? "").trim().toUpperCase();
    if (c) countryVotes.set(c, (countryVotes.get(c) ?? 0) + 1);
  }
  const topCountry = [...countryVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  // Segmentación: con mercado activo de un solo país, el geo manda (no la moda).
  const forcedGeo =
    scope?.countries && scope.countries.length === 1 ? scope.countries[0].toUpperCase() : null;
  const geoLine = forcedGeo
    ? `Mercado activo: ${countryName(forcedGeo)} (solo negocios de ${countryName(forcedGeo)}; excluye otros países con 0)`
    : null;
  // Firmográficos de esos top (si hay cobertura; si no, se omite sin romper).
  const doms = [...new Set(rows.map((r) => domainFromEmail(String(r.email ?? ""))).filter((d) => d && classifyDomain(d).enrichable))].slice(0, 20);
  let industries: string[] = [];
  if (doms.length > 0) {
    const { data: drows } = await db.from("domains").select("industry,company_name").in("domain", doms).limit(20);
    industries = ((drows ?? []) as Array<Record<string, unknown>>)
      .map((d) => String(d.industry ?? "").trim())
      .filter(Boolean)
      .slice(0, 5);
  }
  const p = profile ?? {};
  // Brain TX rico (sin N+1): activos + marcas que anuncian + vocabulario +
  // lo que repite + ticket p50/p80. Antes solo iban títulos/categorías.
  let txLines: string[] = [];
  try {
    const { getTenantBrain } = await import("@/lib/brain");
    const brain = await getTenantBrain(storeId).catch(() => null);
    const tops = (brain?.topProductos ?? []).slice(0, 3).map((t) => t.title).filter(Boolean);
    const cats = (brain?.topCategorias ?? []).slice(0, 3).map((c) => c.categoria).filter(Boolean);
    const marcas = (brain?.topMarcas ?? []).slice(0, 5).map((m) => m.marca).filter(Boolean);
    const voz = (brain?.vozCliente ?? []).filter((w) => w.length >= 5 && !/^(desde|hasta|entre)$/.test(w)).slice(0, 6);
    const repite = (brain?.patronesRepite?.topRepeatTitles ?? []).slice(0, 3).map((t) => t.title).filter(Boolean);
    const p80 = brain?.ticketP80 != null ? ` · p80 ${formatMoney(brain.ticketP80, brain.ticketCurrency)}` : "";
    if (tops.length > 0 || cats.length > 0) {
      txLines.push(`Lo que más se vende (activos): ${tops.join(" · ") || "—"}${cats.length > 0 ? ` · líneas ${cats.join(", ")}` : ""}`);
    }
    if (marcas.length > 0) txLines.push(`Marcas que ya anuncian contigo: ${marcas.join(", ")} (busca pares: distribuidores, competencia, complementos)`);
    if (voz.length > 0) txLines.push(`Vocabulario de tus anuncios: ${voz.join(", ")}`);
    if (repite.length > 0) txLines.push(`Pantallas que más repiten compra: ${repite.join(" · ")}`);
    if (brain?.ticketP50 != null || brain?.ticketP80 != null) txLines.push(`Ticket tienda p50 ~${formatMoney(brain.ticketP50 ?? 0, brain.ticketCurrency)}${p80}`);
  } catch {
    txLines = [];
  }
  // Feedback humano (si existe): aprobados como "más como estos", rechazados como "evita".
  let goodLine: string | null = null;
  let badLine: string | null = null;
  try {
    const [{ data: appr }, { data: rej }] = await Promise.all([
      db.from("proposed_leads").select("company,domain").eq("store_id", storeId).in("status", ["approved", "contacted"]).order("created_at", { ascending: false }).limit(5),
      db.from("proposed_leads").select("company,domain").eq("store_id", storeId).eq("status", "rejected").order("created_at", { ascending: false }).limit(5),
    ]);
    const anames = ((appr ?? []) as Array<Record<string, unknown>>).map((r) => String(r.company ?? r.domain ?? "").trim()).filter(Boolean).slice(0, 5);
    const rnames = ((rej ?? []) as Array<Record<string, unknown>>).map((r) => String(r.company ?? r.domain ?? "").trim()).filter(Boolean).slice(0, 5);
    if (anames.length > 0) goodLine = `Aprobados antes (más como estos): ${anames.join(", ")}`;
    if (rnames.length > 0) badLine = `Rechazados antes (evita este perfil): ${rnames.join(", ")}`;
  } catch {
    // sin feedback: se omite
  }
  const lines = [
    `Negocio: ${String(p.vertical_detected ?? p.description ?? "ecommerce").toString().slice(0, 200)}`,
    `Comprador ideal: ${String(p.buyer_type ?? "").toString().slice(0, 160) || "negocios que ya compraron y gastaron más"}`,
    geoLine,
    `Evidencia top-20: ${formatNumber(b2b)}/20 son B2B · ticket mediano ~${medianTxt}${topCountry ? ` · país moda ${topCountry}` : ""}`,
    industries.length > 0 ? `Industrias top en tus mejores (1 query por industria, no las mezcles): ${[...new Set(industries)].slice(0, 5).join(" | ")}` : null,
    ...txLines,
    goodLine,
    badLine,
    `Ejemplos de dominios que sí te compran: ${doms.slice(0, 8).join(", ") || "—"}`,
    "Buscar: negocios parecidos a esos (misma industria/tamaño, con web propia y contacto público). 1 tema por query. Excluir marketplaces, redes sociales y documentos PDF.",
  ].filter(Boolean);
  return (lines as string[]).join("\n");
}

async function prospectComplete(system: string, user: string, meter?: { storeId: string }): Promise<string> {
  const cfg = getLlmConfig("prospect_scan");
  // 3 intentos [primario, fallback, fallback]: el vaciado intermitente
  // (choices con content vacío) suele resolverse reintentando. Se loguea
  // cada fallo porque antes el error primario se tragaba en silencio.
  const order = [cfg.primary, cfg.fallback, cfg.fallback].filter(Boolean) as typeof cfg.primary[];
  let lastErr: unknown = null;
  for (let i = 0; i < order.length; i++) {
    try {
      return await completeJson(order[i], cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user, meter ? { storeId: meter.storeId, process: "prospect_scan", usedFallback: i > 0 } : undefined);
    } catch (e) {
      lastErr = e;
      log(`complete intento ${i + 1}/${order.length} ${order[i].provider}/${order[i].model} falló (${e instanceof Error ? e.message : e})`);
      if (i < order.length - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface SimilarPoolEntry {
  domain: string;
  label: string;
  industry: string;
  spent_minor: number;
  orders: number;
  /** ISO2 del customer de referencia (el lead hereda su moda). */
  country: string | null;
}

/** Pool determinista (query, sin LLM): top compradores con industria verificada.
 *  El MODELO elige los parecidos dentro de este pool al puntuar.
 *  Con scope, el pool se filtra al mercado activo (segmentación). */
async function buildSimilarPool(storeId: string, limit = 15, scope?: ProspectScope | null): Promise<SimilarPoolEntry[]> {
  const db = getSupabase();
  // Dominios de ESTA tienda (no tabla global cortada a 2000): paginado + .in chunkeado.
  const storeDomains = new Set<string>();
  for (let off = 0; ; off += 1000) {
    const { data: cpage, error: cErr } = await db
      .from("customers")
      .select("email")
      .eq("store_id", storeId)
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (cErr) break;
    const rows = (cpage ?? []) as Array<Record<string, unknown>>;
    for (const c of rows) {
      const d = domainFromEmail(String(c.email ?? ""));
      if (d && classifyDomain(d).enrichable) storeDomains.add(d.toLowerCase());
    }
    if (rows.length < 1000) break;
    if (storeDomains.size >= 10000) break;
  }
  const [{ data: ce }, dr] = await Promise.all([
    db
      .from("customers")
      .select("email,company_name,orders_count,total_spent,country")
      .eq("store_id", storeId)
      .gt("orders_count", 0)
      .order("total_spent", { ascending: false })
      .limit(60),
    (async () => {
      const doms = [...storeDomains].slice(0, 2000);
      const out: Array<Record<string, unknown>> = [];
      for (let i = 0; i < doms.length; i += 200) {
        const { data } = await db.from("domains").select("domain,industry,company_name").in("domain", doms.slice(i, i + 200));
        out.push(...((data ?? []) as Array<Record<string, unknown>>));
      }
      return out;
    })(),
  ]);
  const indByDomain = new Map<string, { industry: string; company: string | null }>();
  for (const d of ((dr ?? []) as Array<Record<string, unknown>>)) {
    const ind = String(d.industry ?? "").trim();
    if (d.domain && ind)
      indByDomain.set(String(d.domain).toLowerCase(), {
        industry: ind,
        company: (d.company_name as string | null) ?? null,
      });
  }
  const out: SimilarPoolEntry[] = [];
  for (const c of ((ce ?? []) as Array<Record<string, unknown>>)) {
    if (scope && (scope.countries?.length || scope.customerIds?.length)) {
      const cc = String(c.country ?? "").trim().toUpperCase();
      if (scope.countries && scope.countries.length > 0) {
        if (cc && !scope.countries.map((x) => x.toUpperCase()).includes(cc)) continue;
      } else if (scope.customerIds && scope.customerIds.length > 0) {
        // Fallback sin países: el top ya trae id solo si se pidió; aquí sin id
        // no se puede filtrar: se conserva (el ICP ya segmentó).
      }
    }
    const d = domainFromEmail(String(c.email ?? ""));
    if (!d || !classifyDomain(d).enrichable) continue;
    const hit = indByDomain.get(d.toLowerCase());
    if (!hit) continue;
    out.push({
      domain: d,
      label: hit.company || String(c.company_name ?? "").trim() || d,
      industry: hit.industry,
      spent_minor: Number(c.total_spent ?? 0),
      orders: Number(c.orders_count ?? 0),
      country: (c.country as string | null) ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

interface SimilarPick {
  domain: string;
  why: string;
}

/**
 * País del lead = mercado activo si es de un solo país (segmentación);
 * si no, moda del país de sus referencias verificadas (pool).
 * null = sin evidencia (comodín: se ve en todo filtro). Nunca por TLD de la
 * URL: un .com mal etiquetado ocultaría el lead del mercado correcto.
 */
function leadCountry(
  s: Pick<Scored, "similar">,
  poolByDomain: Map<string, SimilarPoolEntry>,
  forcedCountry?: string | null,
): string | null {
  if (forcedCountry) return forcedCountry;
  const votes = new Map<string, number>();
  for (const ref of s.similar) {
    const c = poolByDomain.get(ref.domain.toLowerCase())?.country;
    if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
  }
  return modeCountry(votes);
}

/** Umbral de score: con retrieval enfocado, <0.5 es ruido. */
const SCORE_MIN = 0.5;
/** Máx leads por industria y corrida (anti-sesgo: no todo de 1 sector). */
const MAX_PER_INDUSTRY = 2;

interface Scored {
  index: number;
  company: string | null;
  domain: string | null;
  contact: string | null;
  icp_score: number;
  reason: string;
  similar: SimilarPick[];
}

/** Embeddings runtime (sin BD): 1 fetch batch por corrida.
 *  Modelo via EMBEDDINGS_MODEL (default text-embedding-3-small); key del
 *  proveedor OpenAI configurado. Con metering best-effort; falla → pool
 *  completo (conducta anterior). */
async function embedTexts(texts: string[], meter?: { storeId: string }): Promise<number[][]> {
  const model = process.env.EMBEDDINGS_MODEL?.trim() || "text-embedding-3-small";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY");
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts }),
      // 1 batch por corrida: 60s sobra y evita colgar el pipeline.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error("embeddings: timeout (60s) sin respuesta");
    }
    throw e;
  }
  if (!res.ok) throw new Error(`embeddings ${res.status}`);
  const data = await res.json();
  if (meter?.storeId) {
    try {
      const { logLlmUsage } = await import("@/lib/ai/usage");
      const usage = (data as Record<string, unknown>)?.usage as Record<string, unknown> | undefined;
      const promptTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
      const totalTokens = typeof usage?.total_tokens === "number" ? usage.total_tokens : promptTokens;
      if (promptTokens != null) {
        void logLlmUsage({
          storeId: meter.storeId, process: "prospect_embed", provider: "openai", model,
          promptTokens, completionTokens: 0, totalTokens: totalTokens ?? promptTokens,
          reasoningTokens: 0, latencyMs: Date.now() - t0, usedFallback: false,
        });
      }
    } catch {
      // metering best-effort
    }
  }
  const vecs = (data?.data ?? []) as Array<{ index: number; embedding: number[] }>;
  return vecs
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
    .filter((v) => Array.isArray(v));
}

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : d / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Top-k del pool por similitud semántica con el texto del candidato.
 *  Puro retrieval: no decide, solo recorta para que el LLM vea 3 en vez de 12. */
function rankTop(
  query: number[],
  pool: SimilarPoolEntry[],
  poolVecs: number[][],
  k = 3,
): SimilarPoolEntry[] {
  return pool
    .map((p, i) => ({ p, s: cosine(query, poolVecs[i] ?? []) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, k))
    .map((r) => r.p);
}

async function scoreLeads(
  icp: string,
  cands: Scraped[],
  focus?: string | null,
  pool: SimilarPoolEntry[] = [],
  /** Retrieval previo por candidato: solo estas referencias ve el modelo.
   *  null = sin retrieval (pool completo, conducta anterior). */
  topByIndex: Map<number, SimilarPoolEntry[]> | null = null,
  meter?: { storeId: string },
  geoLabel?: string | null,
): Promise<Scored[]> {
  if (cands.length === 0) return [];
  // Lotes de 4: acota el prompt (los vaciados crecen con payloads grandes)
  // y cada lote reintenta por su cuenta vía prospectComplete.
  const out: Scored[] = [];
  for (let off = 0; off < cands.length; off += 4) {
    const chunk = cands.slice(off, off + 4);
    const subTop = topByIndex !== null ? new Map(chunk.map((_, k) => [k, topByIndex.get(off + k) ?? pool])) : null;
    const scored = await scoreChunk(icp, chunk, focus, pool, subTop, meter, geoLabel);
    for (const s of scored) {
      const globalIdx = off + s.index;
      const valid = new Set(((subTop?.get(s.index) ?? pool).map((p) => p.domain.toLowerCase())));
      if (!cands[globalIdx]) continue;
      // Gate contacto: sin email/tel/RRSS públicos no es accionable → fuera.
      // (Antes se guardaba "solo formulario"; la lista debe ser contactable.)
      const cc = cands[globalIdx]?.contacts;
      const hasAnyContact =
        (cc?.emails?.length ?? 0) > 0 || (cc?.phones?.length ?? 0) > 0 || (cc?.socials?.length ?? 0) > 0;
      // Fallback determinista: si el LLM no devolvió email/tel válido (o
      // alucinó un nombre como "Luis Cueva"), se usa el primero del scrape.
      const llmContact = sanitizeLeadContact(s.contact) ?? pickLeadContact(cc);
      if (!hasAnyContact && !llmContact) continue;
      out.push({
        ...s,
        contact: llmContact ?? pickLeadContact(cc),
        index: globalIdx,
        similar: s.similar.filter((x) => valid.has(x.domain.toLowerCase())).slice(0, 2),
      });
    }
  }
  return out.filter((l) => l && l.icp_score >= SCORE_MIN);
}

/** Contacto válido = SOLO email o teléfono (implementación pura en retrieval;
 *  el LLM a veces devuelve nombres como "Luis Cueva": se descarta a null;
 *  scoreLeads lo importa arriba y aplica el fallback determinista). */

/** Un lote (≤4 candidatos) en una sola llamada LLM. Índices locales al lote.
 *  `topByIndex` restringe las referencias visibles por candidato (retrieval);
 *  null = bloque único de pool (conducta anterior). */
function contactBlock(c: Scraped): string {
  const parts: string[] = [];
  if (c.contacts?.emails?.length) parts.push(`emails: ${c.contacts.emails.join(", ")}`);
  if (c.contacts?.phones?.length) parts.push(`tels: ${c.contacts.phones.join(", ")}`);
  if (c.contacts?.socials?.length)
    parts.push(`rrss: ${c.contacts.socials.map((s) => `${s.network}:${s.url}`).join(" | ").slice(0, 400)}`);
  return parts.length > 0 ? `CONTACTO_DETECTADO (público, úsalo en contact si encaja): ${parts.join(" · ")}\n` : "";
}

async function scoreChunk(
  icp: string,
  cands: Scraped[],
  focus: string | null | undefined,
  pool: SimilarPoolEntry[],
  topByIndex: Map<number, SimilarPoolEntry[]> | null,
  meter?: { storeId: string },
  geoLabel?: string | null,
): Promise<Scored[]> {
  const usePerCand = topByIndex !== null;
  const refBlock = (i: number): string => {
    const refs = topByIndex?.get(i) ?? [];
    if (refs.length === 0) return "";
    return `Referencias verificadas para [${i}] (elige similar SOLO de aquí):\n${refs.map((p) => `- ${p.domain} | ${p.label} | ${p.industry}`).join("\n")}\n`;
  };
  const poolBlock = usePerCand
    ? ""
    : pool.length > 0
      ? `\nCLIENTES DE REFERENCIA (verificados, ya te compran):\n${pool.map((p) => `- ${p.domain} | ${p.label} | ${p.industry}`).join("\n")}\n`
      : "";
  const geoGate = geoLabel
    ? ` Mercado: ${geoLabel} — si el candidato es claramente de otro país (dominio .mx/.ec/.co/.cl/.ar, dirección o teléfono de otro país, sin mención a ${geoLabel}), icp_score 0 sin excepciones.`
    : "";
  const rubric =
    "Rúbrica (pondera, no es checklist ciego): industria parecida 40 · tamaño/ticket coherente con el ICP 25 · geografía correcta 20 · contacto público claro 15." +
    " Descarta con 0: marketplaces, redes sociales, documentos PDF, otro país (si hay mercado), o sin ningún parecido real con las referencias." +
    " Sin CONTACTO_DETECTADO pon contact null (no inventes); el gate de contacto lo filtra después, pero castiga el score a ≤0.3." +
    geoGate;
  const raw = await prospectComplete(
    "Puntúas candidatos vs un ICP. Responde SOLO JSON: {\"leads\": [{\"index\": n, \"company\": string|null, \"domain\": string|null, \"contact\": string|null, \"icp_score\": 0..1, \"reason\": string, \"similar\": [{\"domain\": string, \"why\": string}]}]}. Descarta (icp_score 0) lo que no encaje. contact: SOLO email o teléfono del CONTACTO_DETECTADO (el mejor: email > teléfono); si no hay bloque, null salvo email/tel literal en el texto. PROHIBIDO nombres de personas, cargos, URLs o direcciones en contact (p.ej. nunca \"Luis Cueva\"). reason: 1 frase corta (máx 25 palabras) que diga industria + por qué encaja. similar: hasta 2 clientes de REFERENCIA que más se parezcan al candidato, con why en español y corto anclado en sustantivo de industria (p.ej. \"ambos en bienestar animal\"). PROHIBIDO usar verbos genéricos en why (importación, distribución, fabricación, comercialización, ventas). Si ninguno se parece de verdad, similar=[]. " + rubric,
    `ICP:\n${icp.slice(0, 1500)}\n${focus ? `\nEnfoque de ESTA corrida (excluye con 0 lo que lo contradiga): ${focus}\n` : ""}${poolBlock}\nCANDIDATOS:\n${cands.map((c, i) => `[${i}] ${c.url}\n${c.title}\n${contactBlock(c)}${c.text.slice(0, 1500)}\n${usePerCand ? refBlock(i) : ""}`).join("\n\n")}`,
    meter,
  );
  // El truncado (max_tokens) da JSON cortado: un reintento con muestra fresca
  // suele bastar; si repite, que falle el lote con error legible.
  let parsed: { leads?: Scored[] };
  try {
    parsed = JSON.parse(raw) as { leads?: Scored[] };
  } catch {
    log(`scoreChunk JSON cortado (lote ${cands.length}), reintento con muestra fresca`);
    const retry = await prospectComplete(
      "Puntúas candidatos vs un ICP. Responde SOLO JSON compacto: {\"leads\": [{\"index\": n, \"company\": string|null, \"domain\": string|null, \"contact\": string|null, \"icp_score\": 0..1, \"reason\": string, \"similar\": [{\"domain\": string, \"why\": string}]}]}. contact: SOLO email o teléfono del CONTACTO_DETECTADO, si no hay, null. PROHIBIDO nombres de personas. reason: máx 15 palabras con industria. similar: máx 1. " + rubric,
      `ICP:\n${icp.slice(0, 800)}\nCANDIDATOS:\n${cands.map((c, i) => `[${i}] ${c.url}\n${c.title}\n${contactBlock(c)}${c.text.slice(0, 800)}\n${usePerCand ? refBlock(i) : ""}`).join("\n\n")}`,
      meter,
    );
    parsed = JSON.parse(retry) as { leads?: Scored[] };
  }
  // Normalización blanda; el filtro >=SCORE_MIN y el remapeo global los hace scoreLeads.
  return (Array.isArray(parsed.leads) ? parsed.leads : [])
    .filter((l) => l && cands[l.index])
    .map((l) => ({
      ...l,
      similar: (Array.isArray(l.similar) ? l.similar : [])
        .filter((s) => s && typeof s.domain === "string" && s.domain.trim())
        .slice(0, 2)
        .map((s) => ({ domain: String(s.domain), why: String(s.why ?? "").slice(0, 120) })),
    }));
}

/** Dedupe: ni URLs ya propuestas ni dominios que ya son customers. Paginado completo. */
async function dedupe(storeId: string, cands: Scraped[], scored: Scored[]): Promise<Scored[]> {
  const db = getSupabase();
  const seenUrls = new Set<string>();
  for (let off = 0; ; off += 1000) {
    const { data: lpage } = await db.from("proposed_leads").select("url").eq("store_id", storeId).order("id", { ascending: true }).range(off, off + 999);
    const rows = (lpage ?? []) as Array<Record<string, unknown>>;
    for (const l of rows) seenUrls.add(String(l.url));
    if (rows.length < 1000) break;
    if (seenUrls.size >= 20000) break;
  }
  const customerDomains = new Set<string>();
  for (let off = 0; ; off += 1000) {
    const { data: cpage } = await db.from("customers").select("email").eq("store_id", storeId).order("id", { ascending: true }).range(off, off + 999);
    const rows = (cpage ?? []) as Array<Record<string, unknown>>;
    for (const c of rows) {
      const d = domainFromEmail(String(c.email ?? ""));
      if (d && classifyDomain(d).enrichable) customerDomains.add(d);
    }
    if (rows.length < 1000) break;
    if (customerDomains.size >= 20000) break;
  }
  return scored.filter((s) => {
    const url = cands[s.index]?.url ?? "";
    if (!url || seenUrls.has(url)) return false;
    const host = hostOf(url);
    if (host && customerDomains.has(host)) return false; // ya es customer
    return true;
  });
}

export interface ProspectOpts {
  queries?: number;
  perQuery?: number;
  maxCands?: number;
  /** Enfoque de esta corrida (p.ej. "centros comerciales pequeños, excluir grandes malls"). */
  focus?: string | null;
  /** Segmentación por mercado activo (SSOT markets). null = todos. */
  scope?: ProspectScope | null;
  /** Etiqueta del mercado para el summary (p.ej. "PE · PEN"). */
  marketLabel?: string | null;
}

/** Pendientes de revisión (el tope del inbox se mide sobre esto). */
export async function countPendingLeads(storeId: string): Promise<number> {
  const { count, error } = await getSupabase()
    .from("proposed_leads")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("status", "pending_review");
  if (error) throw new Error(`Leads count: ${error.message}`);
  return count ?? 0;
}

/** Pipeline completo con progreso en vivo en background_runs. */
export async function runProspect(runId: string, storeId: string, opts: ProspectOpts = {}): Promise<void> {
  const { queries: nQ = 3, perQuery = 5, maxCands = 8, focus = null, scope = null, marketLabel = null } = opts;
  let processed = 0;
  let failed = 0;
  const step = (current: string | null) => advanceRun(runId, { processed, failed, current });
  const forcedGeo =
    scope?.countries && scope.countries.length === 1 ? scope.countries[0].toUpperCase() : null;
  const geoLabel = forcedGeo ? countryName(forcedGeo) : null;
  // El geo del mercado se inyecta como foco extra (manda como el focus).
  const marketFocus = geoLabel
    ? `Mercado activo ${geoLabel} (solo negocios de ${geoLabel}; excluye otros países con 0)${focus ? ` · ${focus}` : ""}`
    : focus;

  try {
    const icp = await getIcp(storeId, scope);
    await step(null);
    const queries = await buildQueries(icp.text, nQ, marketFocus, { storeId });

    const hits: SearchHit[] = [];
    for (const q of queries) {
      await step(null);
      try {
        hits.push(...(await searchSearxng(q, perQuery)));
      } catch {
        failed += 1;
      }
    }
    const { rankHits } = await import("@/lib/retrieval");
    const urls = [...new Set(rankHits(hits).map((h) => h.url))].slice(0, maxCands * 2);
    if (urls.length === 0) throw new Error("Sin resultados esta vez, lo reintentamos solo.");
    const { ok: scrapableUrls } = scrapable(urls);
    const targets = scrapableUrls.slice(0, maxCands);
    if (targets.length === 0) throw new Error("Solo encontramos redes cerradas, ajustamos la búsqueda.");

    await step(null);
    const scraped = await scrapeCandidates(targets);
    failed += targets.length - scraped.length;
    if (scraped.length === 0) throw new Error("Scrape sin texto útil (muros de login/bot en todas).");

    await step("score");
    const icpText = icp.text;
    const pool = await buildSimilarPool(storeId, 15, scope).catch(() => [] as SimilarPoolEntry[]);
    // Retrieval runtime (sin BD): top-3 por candidato para achicar el prompt.
    // Si falla, null = pool completo (conducta anterior).
    let topByIndex: Map<number, SimilarPoolEntry[]> | null = null;
    if (pool.length > 3 && scraped.length > 0) {
      try {
        const vecs = await embedTexts([
          ...pool.map((p) => `${p.label}. ${p.industry}`),
          ...scraped.map((c) => `${c.title}. ${c.text.slice(0, 800)}`),
        ], { storeId });
        const poolVecs = vecs.slice(0, pool.length);
        const candVecs = vecs.slice(pool.length);
        topByIndex = new Map(scraped.map((_, i) => [i, rankTop(candVecs[i] ?? [], pool, poolVecs, 3)]));
        log(`run ${runId} retrieval ok (${pool.length}→3 por candidato)`);
      } catch (e) {
        log(`run ${runId} retrieval falló (${e instanceof Error ? e.message : e}); pool completo`);
        topByIndex = null;
      }
    }
    const scored = await scoreLeads(icpText, scraped, marketFocus, pool, topByIndex, { storeId }, geoLabel);
    // Anti-sesgo: tope por industria y corrida (no terminar todo de 1 sector).
    // Industria = la del primer similar (referencia verificada); sin similar va al final.
    const poolIndByDomain = new Map(pool.map((p) => [p.domain.toLowerCase(), p.industry]));
    const perInd = new Map<string, number>();
    const diverse = [...scored]
      .sort((a, b) => (b.icp_score ?? 0) - (a.icp_score ?? 0))
      .filter((s) => {
        const ind = (s.similar.length > 0 ? (poolIndByDomain.get(s.similar[0].domain.toLowerCase()) ?? s.similar[0].domain) : "sin-referencia").toLowerCase();
        const n = perInd.get(ind) ?? 0;
        if (n >= MAX_PER_INDUSTRY) return false;
        perInd.set(ind, n + 1);
        return true;
      });
    if (diverse.length < scored.length) {
      log(`run ${runId} anti-sesgo: ${scored.length}→${diverse.length} (máx ${MAX_PER_INDUSTRY}/industria)`);
    }
    const fresh = await dedupe(storeId, scraped, diverse);
    const poolByDomain = new Map(pool.map((p) => [p.domain.toLowerCase(), p]));

    await step(`guardar (${fresh.length})`);
    if (fresh.length > 0) {
      const { error } = await getSupabase().from("proposed_leads").upsert(
        fresh.map((s) => ({
          store_id: storeId,
          source: "searxng",
          country: leadCountry(s, poolByDomain, forcedGeo),
          company: s.company,
          domain: s.domain ?? (hostOf(scraped[s.index]?.url ?? "") || null),
          url: scraped[s.index]?.url ?? "",
          contact: s.contact,
          icp_score: s.icp_score,
          reason: s.reason,
          status: "pending_review",
          evidence_json: {
            generator: PROSPECT_GEN,
            icp_manual: icp.manual,
            queries,
            contacts: scraped[s.index]?.contacts ?? { emails: [], phones: [], socials: [] },
            similar: s.similar.map((ref) => {
              const p = poolByDomain.get(ref.domain.toLowerCase());
              return p ? { ...p, why: ref.why } : { domain: ref.domain, why: ref.why };
            }),
            scored_at: new Date().toISOString(),
          },
        })),
        { onConflict: "store_id,url" },
      );
      if (error) throw new Error(`Leads upsert: ${error.message}`);
    }
    processed = fresh.length;
    const status: RunStatus = "done";
    // Filosofía TeamPulse: outcome humano. El foco es lenguaje del usuario,
    // se conserva; los fallidos van en su columna.
    const focusTag = focus ? ` · foco: ${focus.slice(0, 60)}` : "";
    const marketTag = marketLabel ? ` · ${marketLabel}` : geoLabel ? ` · ${geoLabel}` : "";
    const summary =
      processed > 0
        ? `${formatNumber(processed)} parecidos a tu ideal por revisar${marketTag}${focusTag}`
        : `En pausa, primero recuperamos lo tuyo${marketTag}${focusTag}`;
    await finishRun(runId, {
      status,
      processed,
      failed,
      summary,
      pulseState: processed > 0 ? "needs" : "paused",
    });
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed,
      failed,
      error: formatRunError(e),
    });
  }
}
