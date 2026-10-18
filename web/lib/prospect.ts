// Lead stream (prospector, Fase B): ICP manual → queries LLM → SearXNG →
// scrape (Crawlee Cheerio) → score LLM vs ICP → proposed_leads PENDING_REVIEW.
// El prospector propone; nunca contacta solo.
import { getSupabase } from "@/lib/supabase";
import { modeCountry } from "@/lib/medusa";
import { classifyDomain, domainFromEmail } from "@/lib/domains";
import { getLlmConfig } from "@/lib/ai/llm-config";
import {
  buildQueries,
  completeJson,
  hostOf,
  scrapeCandidates,
  scrapable,
  searchSearxng,
  type Scraped,
  type SearchHit,
} from "@/lib/retrieval";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";

const log = createLogger("prospect");

/** Versión del criterio prospector. Sube cuando cambia scoring/retrieval. */
export const PROSPECT_GEN = "prospect:v3:hybrid";

export interface Icp {
  text: string;
  manual: boolean;
}

/** ICP V1 manual + auto-derivado: si no hay icp_description, se construye desde
 *  los mejores compradores (top gasto) + firmográficos + perfil. Así el
 *  prospector deja de dar 0 sin intervención manual. */
export async function getIcp(storeId: string): Promise<Icp> {
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
    const auto = await buildAutoIcp(storeId, p);
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

/** Top compradores → industrias/tipos dominantes → texto ICP. null si sin base. */
export async function buildAutoIcp(storeId: string, profile?: Record<string, unknown>): Promise<string | null> {
  const db = getSupabase();
  const { data: top, error } = await db
    .from("customers")
    .select("email,customer_type,orders_count,total_spent")
    .eq("store_id", storeId)
    .gt("orders_count", 0)
    .order("total_spent", { ascending: false })
    .limit(20);
  if (error || !top || top.length < 3) return null;
  const rows = top as Array<Record<string, unknown>>;
  const b2b = rows.filter((r) => String(r.customer_type ?? "") === "B2B").length;
  const tickets = rows
    .map((r) => Number(r.total_spent ?? 0) / Math.max(1, Number(r.orders_count ?? 1)))
    .sort((a, b) => a - b);
  const median = Math.round(tickets[Math.floor(tickets.length / 2)] / 100);
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
  const lines = [
    `Negocio: ${String(p.vertical_detected ?? p.description ?? "ecommerce").toString().slice(0, 200)}`,
    `Comprador ideal: ${String(p.buyer_type ?? "").toString().slice(0, 160) || "negocios que ya compraron y gastaron más"}`,
    `Evidencia top-20: ${b2b}/20 son B2B · ticket mediano ~S/ ${median}`,
    industries.length > 0 ? `Industrias top en tus mejores: ${[...new Set(industries)].slice(0, 5).join(", ")}` : null,
    `Ejemplos de dominios que sí te compran: ${doms.slice(0, 8).join(", ") || "—"}`,
    "Buscar: negocios parecidos a esos (misma industria/tamaño, con web propia y contacto público). Excluir marketplaces y redes sociales.",
  ].filter(Boolean);
  return lines.join("\n");
}

async function prospectComplete(system: string, user: string): Promise<string> {
  const cfg = getLlmConfig("prospect_scan");
  // 3 intentos [primario, fallback, fallback]: el vaciado intermitente
  // (choices con content vacío) suele resolverse reintentando. Se loguea
  // cada fallo porque antes el error primario se tragaba en silencio.
  const order = [cfg.primary, cfg.fallback, cfg.fallback].filter(Boolean) as typeof cfg.primary[];
  let lastErr: unknown = null;
  for (let i = 0; i < order.length; i++) {
    try {
      return await completeJson(order[i], cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user);
    } catch (e) {
      lastErr = e;
      log(`complete intento ${i + 1}/${order.length} ${order[i].provider}/${order[i].model} falló (${e instanceof Error ? e.message : e})`);
      if (i < order.length - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface SimilarPoolEntry {
  domain: string;
  label: string;
  industry: string;
  spent_minor: number;
  orders: number;
  /** ISO2 del customer de referencia (el lead hereda su moda). */
  country: string | null;
}

/** Pool determinista (query, sin LLM): top compradores con industria verificada.
 *  El MODELO elige los parecidos dentro de este pool al puntuar. */
export async function buildSimilarPool(storeId: string, limit = 15): Promise<SimilarPoolEntry[]> {
  const db = getSupabase();
  const [{ data: ce }, { data: dr }] = await Promise.all([
    db
      .from("customers")
      .select("email,company_name,orders_count,total_spent,country")
      .eq("store_id", storeId)
      .gt("orders_count", 0)
      .order("total_spent", { ascending: false })
      .limit(60),
    db.from("domains").select("domain,industry,company_name").limit(2000),
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

export interface SimilarPick {
  domain: string;
  why: string;
}

/**
 * País del lead = moda del país de sus referencias verificadas (pool).
 * null = sin evidencia (comodín: se ve en todo filtro). Nunca por TLD de la
 * URL: un .com mal etiquetado ocultaría el lead del mercado correcto.
 */
function leadCountry(
  s: Pick<Scored, "similar">,
  poolByDomain: Map<string, SimilarPoolEntry>,
): string | null {
  const votes = new Map<string, number>();
  for (const ref of s.similar) {
    const c = poolByDomain.get(ref.domain.toLowerCase())?.country;
    if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
  }
  return modeCountry(votes);
}

export interface Scored {
  index: number;
  company: string | null;
  domain: string | null;
  contact: string | null;
  icp_score: number;
  reason: string;
  similar: SimilarPick[];
}

/** Embeddings runtime (sin BD): 1 fetch batch por corrida (~2s, <$0.001).
 *  Falla → el llamador usa el pool completo (conducta anterior). */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}`);
  const data = await res.json();
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
export function rankTop(
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

export async function scoreLeads(
  icp: string,
  cands: Scraped[],
  focus?: string | null,
  pool: SimilarPoolEntry[] = [],
  /** Retrieval previo por candidato: solo estas referencias ve el modelo.
   *  null = sin retrieval (pool completo, conducta anterior). */
  topByIndex: Map<number, SimilarPoolEntry[]> | null = null,
): Promise<Scored[]> {
  if (cands.length === 0) return [];
  // Lotes de 4: acota el prompt (los vaciados crecen con payloads grandes)
  // y cada lote reintenta por su cuenta vía prospectComplete.
  const out: Scored[] = [];
  for (let off = 0; off < cands.length; off += 4) {
    const chunk = cands.slice(off, off + 4);
    const subTop = topByIndex !== null ? new Map(chunk.map((_, k) => [k, topByIndex.get(off + k) ?? pool])) : null;
    const scored = await scoreChunk(icp, chunk, focus, pool, subTop);
    for (const s of scored) {
      const globalIdx = off + s.index;
      const valid = new Set(((subTop?.get(s.index) ?? pool).map((p) => p.domain.toLowerCase())));
      if (!cands[globalIdx]) continue;
      out.push({
        ...s,
        index: globalIdx,
        similar: s.similar.filter((x) => valid.has(x.domain.toLowerCase())).slice(0, 2),
      });
    }
  }
  return out.filter((l) => l && l.icp_score > 0.3);
}

/** Un lote (≤4 candidatos) en una sola llamada LLM. Índices locales al lote.
 *  `topByIndex` restringe las referencias visibles por candidato (retrieval);
 *  null = bloque único de pool (conducta anterior). */
async function scoreChunk(
  icp: string,
  cands: Scraped[],
  focus: string | null | undefined,
  pool: SimilarPoolEntry[],
  topByIndex: Map<number, SimilarPoolEntry[]> | null,
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
  const raw = await prospectComplete(
    "Puntúas candidatos vs un ICP. Responde SOLO JSON: {\"leads\": [{\"index\": n, \"company\": string|null, \"domain\": string|null, \"contact\": string|null, \"icp_score\": 0..1, \"reason\": string, \"similar\": [{\"domain\": string, \"why\": string}]}]}. Descarta (icp_score 0) lo que no encaje. contact solo si aparece público en el texto. reason: 1 frase corta (máx 25 palabras). similar: hasta 2 clientes de REFERENCIA que más se parezcan al candidato, con why en español y corto anclado en sustantivo de industria (p.ej. \"ambos en bienestar animal\"). PROHIBIDO usar verbos genéricos en why (importación, distribución, fabricación, comercialización, ventas). Si ninguno se parece de verdad, similar=[].",
    `ICP:\n${icp.slice(0, 1500)}\n${focus ? `\nEnfoque de ESTA corrida (excluye con 0 lo que lo contradiga): ${focus}\n` : ""}${poolBlock}\nCANDIDATOS:\n${cands.map((c, i) => `[${i}] ${c.url}\n${c.title}\n${c.text.slice(0, 1500)}\n${usePerCand ? refBlock(i) : ""}`).join("\n\n")}`,
  );
  // El truncado (max_tokens) da JSON cortado: un reintento con muestra fresca
  // suele bastar; si repite, que falle el lote con error legible.
  let parsed: { leads?: Scored[] };
  try {
    parsed = JSON.parse(raw) as { leads?: Scored[] };
  } catch {
    log(`scoreChunk JSON cortado (lote ${cands.length}), reintento con muestra fresca`);
    const retry = await prospectComplete(
      "Puntúas candidatos vs un ICP. Responde SOLO JSON compacto: {\"leads\": [{\"index\": n, \"company\": string|null, \"domain\": string|null, \"contact\": string|null, \"icp_score\": 0..1, \"reason\": string, \"similar\": [{\"domain\": string, \"why\": string}]}]}. reason: máx 15 palabras. similar: máx 1.",
      `ICP:\n${icp.slice(0, 800)}\nCANDIDATOS:\n${cands.map((c, i) => `[${i}] ${c.url}\n${c.title}\n${c.text.slice(0, 800)}\n${usePerCand ? refBlock(i) : ""}`).join("\n\n")}`,
    );
    parsed = JSON.parse(retry) as { leads?: Scored[] };
  }
  // Normalización blanda; el filtro >0.3 y el remapeo global los hace scoreLeads.
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

/** Dedupe: ni URLs ya propuestas ni dominios que ya son customers. Devuelve índices a guardar. */
export async function dedupe(storeId: string, cands: Scraped[], scored: Scored[]): Promise<Scored[]> {
  const db = getSupabase();
  const [{ data: leads }, { data: customers }] = await Promise.all([
    db.from("proposed_leads").select("url").eq("store_id", storeId).limit(2000),
    db.from("customers").select("email").eq("store_id", storeId).limit(5000),
  ]);
  const seenUrls = new Set(((leads ?? []) as Array<Record<string, unknown>>).map((l) => String(l.url)));
  const customerDomains = new Set(
    ((customers ?? []) as Array<Record<string, unknown>>)
      .map((c) => domainFromEmail(String(c.email ?? "")))
      .filter((d) => d && classifyDomain(d).enrichable),
  );
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
}

/** Pipeline completo con progreso en vivo en background_runs. */
export async function runProspect(runId: string, storeId: string, opts: ProspectOpts = {}): Promise<void> {
  const { queries: nQ = 3, perQuery = 5, maxCands = 8, focus = null } = opts;
  let processed = 0;
  let failed = 0;
  const step = (current: string | null) => advanceRun(runId, { processed, failed, current });

  try {
    const icp = await getIcp(storeId);
    await step(null);
    const queries = await buildQueries(icp.text, nQ, focus);

    const hits: SearchHit[] = [];
    for (const q of queries) {
      await step(null);
      try {
        hits.push(...(await searchSearxng(q, perQuery)));
      } catch {
        failed += 1;
      }
    }
    const urls = [...new Set(hits.map((h) => h.url))].slice(0, maxCands * 2);
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
    const pool = await buildSimilarPool(storeId).catch(() => [] as SimilarPoolEntry[]);
    // Retrieval runtime (sin BD): top-3 por candidato para achicar el prompt.
    // Si falla, null = pool completo (conducta anterior).
    let topByIndex: Map<number, SimilarPoolEntry[]> | null = null;
    if (pool.length > 3 && scraped.length > 0) {
      try {
        const vecs = await embedTexts([
          ...pool.map((p) => `${p.label}. ${p.industry}`),
          ...scraped.map((c) => `${c.title}. ${c.text.slice(0, 800)}`),
        ]);
        const poolVecs = vecs.slice(0, pool.length);
        const candVecs = vecs.slice(pool.length);
        topByIndex = new Map(scraped.map((_, i) => [i, rankTop(candVecs[i] ?? [], pool, poolVecs, 3)]));
        log(`run ${runId} retrieval ok (${pool.length}→3 por candidato)`);
      } catch (e) {
        log(`run ${runId} retrieval falló (${e instanceof Error ? e.message : e}); pool completo`);
        topByIndex = null;
      }
    }
    const scored = await scoreLeads(icpText, scraped, focus, pool, topByIndex);
    const fresh = await dedupe(storeId, scraped, scored);
    const poolByDomain = new Map(pool.map((p) => [p.domain.toLowerCase(), p]));

    await step(`guardar (${fresh.length})`);
    if (fresh.length > 0) {
      const { error } = await getSupabase().from("proposed_leads").upsert(
        fresh.map((s) => ({
          store_id: storeId,
          source: "searxng",
          country: leadCountry(s, poolByDomain),
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
    const summary =
      processed > 0
        ? `${processed} parecidos a tu ideal por revisar${focusTag}`
        : `En pausa, primero recuperamos lo tuyo${focusTag}`;
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
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
