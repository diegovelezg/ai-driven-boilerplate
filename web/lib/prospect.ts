// Lead stream (prospector, Fase B): ICP manual → queries LLM → SearXNG →
// scrape (Crawlee Cheerio) → score LLM vs ICP → proposed_leads PENDING_REVIEW.
// El prospector propone; nunca contacta solo.
import { join } from "node:path";
import { CheerioCrawler } from "@crawlee/cheerio";
import { getSupabase } from "@/lib/supabase";
import { classifyDomain, domainFromEmail } from "@/lib/domains";
import { chatCompletionParams, getLlmConfig, reasoningBody, type ModelRef } from "@/lib/ai/llm-config";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";

process.env.CRAWLEE_STORAGE_DIR ??= join(process.cwd(), ".data", "crawlee");

const SEARXNG_URL = (process.env.SEARXNG_URL ?? "http://localhost:8888").replace(/\/+$/, "");

export interface Icp {
  text: string;
  manual: boolean;
}

/** ICP V1 manual: icp_description del merchant; si falta, se compone del perfil. Sin nada útil → error honesto. */
export async function getIcp(storeId: string): Promise<Icp> {
  const { data, error } = await getSupabase()
    .from("store_profiles")
    .select("business_model,industry,description,icp_description")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(`ICP read: ${error.message}`);
  const p = (data ?? {}) as Record<string, unknown>;
  if (typeof p.icp_description === "string" && p.icp_description.trim()) {
    return { text: p.icp_description.trim(), manual: true };
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

async function completeJson(ref: ModelRef, temp: number, maxTokens: number, effort: string | null, system: string, user: string): Promise<string> {
  const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
  if (!apiKey) throw new Error(`Falta ${ref.apiKeyEnv}`);
  const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: ref.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...chatCompletionParams(ref.provider, ref.model, temp, maxTokens),
    response_format: { type: "json_object" },
    ...reasoningBody(ref.provider, ref.model, effort),
  };
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${ref.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error(`${ref.provider}: respuesta vacía`);
  return content;
}

async function prospectComplete(system: string, user: string): Promise<string> {
  const cfg = getLlmConfig("prospect_scan");
  try {
    return await completeJson(cfg.primary, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user);
  } catch (e) {
    if (!cfg.fallback) throw e;
    return await completeJson(cfg.fallback, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user);
  }
}

export async function buildQueries(icp: string, n = 3, focus?: string | null): Promise<string[]> {
  const raw = await prospectComplete(
    "Generas queries de búsqueda web para encontrar negocios parecidos al ICP. Responde SOLO JSON: {\"queries\": [string]}. Queries en español, variadas. Prefiere queries que devuelvan webs de empresas y directorios indexables; evita site:linkedin.com y redes sociales (muro de login, no scrapeables).",
    `ICP:\n${icp.slice(0, 1500)}\n${focus ? `\nEnfoque de ESTA corrida (manda sobre lo general): ${focus}\n` : ""}\nNº de queries: ${n}`,
  );
  const parsed = JSON.parse(raw) as { queries?: unknown };
  const qs = Array.isArray(parsed.queries) ? parsed.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0) : [];
  if (qs.length === 0) throw new Error("El LLM no devolvió queries.");
  return qs.slice(0, n);
}

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export async function searchSearxng(query: string, perQuery = 5): Promise<SearchHit[]> {
  const u = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&language=es-PE`;
  const res = await fetch(u);
  if (!res.ok) throw new Error(`SearXNG ${res.status} (¿contenedor caído? ${SEARXNG_URL})`);
  const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return ((data.results ?? []).slice(0, perQuery)).map((r) => ({
    url: String(r.url ?? ""),
    title: String(r.title ?? ""),
    snippet: String(r.content ?? ""),
  })).filter((h) => h.url.startsWith("http"));
}

export interface Scraped {
  url: string;
  title: string;
  text: string;
}

/** Scrape estático (Cheerio, sin browser): suficiente para webs de empresas y directorios. */
export async function scrapeCandidates(urls: string[]): Promise<Scraped[]> {
  const out: Scraped[] = [];
  const crawler = new CheerioCrawler({
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 25,
    async requestHandler({ $, request }) {
      $("script,style,nav,footer,header,noscript,iframe").remove();
      const raw = ($("article").text() || $("main").text() || $("body").text() || "").replace(/\s+/g, " ").trim();
      if (raw.length < 200) return; // pared de login/bot o página vacía: se descarta en silencio
      out.push({ url: request.url, title: $("title").first().text().trim().slice(0, 200), text: raw.slice(0, 4000) });
    },
  });
  await crawler.addRequests(urls);
  await crawler.run();
  return out;
}

export interface Scored {
  index: number;
  company: string | null;
  domain: string | null;
  contact: string | null;
  icp_score: number;
  reason: string;
}

export async function scoreLeads(icp: string, cands: Scraped[], focus?: string | null): Promise<Scored[]> {
  if (cands.length === 0) return [];
  const raw = await prospectComplete(
    "Puntúas candidatos vs un ICP. Responde SOLO JSON: {\"leads\": [{\"index\": n, \"company\": string|null, \"domain\": string|null, \"contact\": string|null, \"icp_score\": 0..1, \"reason\": string}]}. Descarta (icp_score 0) lo que no encaje. contact solo si aparece público en el texto.",
    `ICP:\n${icp.slice(0, 1500)}\n${focus ? `\nEnfoque de ESTA corrida (excluye con 0 lo que lo contradiga): ${focus}\n` : ""}\nCANDIDATOS:\n${cands.map((c, i) => `[${i}] ${c.url}\n${c.title}\n${c.text.slice(0, 1500)}`).join("\n\n")}`,
  );
  const parsed = JSON.parse(raw) as { leads?: Scored[] };
  return (Array.isArray(parsed.leads) ? parsed.leads : []).filter((l) => l && l.icp_score > 0.3 && cands[l.index]);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Dominios no scrapeables (login/bot wall): se filtran antes de gastar requests. */
const UNSCRAPABLE = ["linkedin.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com"];

export function scrapable(urls: string[]): { ok: string[]; skipped: number } {
  const ok = urls.filter((u) => {
    const h = hostOf(u);
    return h && !UNSCRAPABLE.some((d) => h === d || h.endsWith(`.${d}`));
  });
  return { ok, skipped: urls.length - ok.length };
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
    await step("queries");
    const queries = await buildQueries(icp.text, nQ, focus);

    const hits: SearchHit[] = [];
    for (const q of queries) {
      await step(`search: ${q.slice(0, 60)}`);
      try {
        hits.push(...(await searchSearxng(q, perQuery)));
      } catch {
        failed += 1;
      }
    }
    const urls = [...new Set(hits.map((h) => h.url))].slice(0, maxCands * 2);
    if (urls.length === 0) throw new Error("SearXNG no devolvió URLs (¿contenedor caído o queries vacías?).");
    const { ok: scrapableUrls, skipped } = scrapable(urls);
    const targets = scrapableUrls.slice(0, maxCands);
    if (targets.length === 0) throw new Error("Solo muros de login (LinkedIn/redes): ajusta las queries a webs indexables.");

    await step(`scrape (${targets.length}${skipped > 0 ? `, ${skipped} muros saltados` : ""})`);
    const scraped = await scrapeCandidates(targets);
    failed += targets.length - scraped.length;
    if (scraped.length === 0) throw new Error("Scrape sin texto útil (muros de login/bot en todas).");

    await step("score");
    const icpText = icp.text;
    const scored = await scoreLeads(icpText, scraped, focus);
    const fresh = await dedupe(storeId, scraped, scored);

    await step(`guardar (${fresh.length})`);
    if (fresh.length > 0) {
      const { error } = await getSupabase().from("proposed_leads").upsert(
        fresh.map((s) => ({
          store_id: storeId,
          source: "searxng",
          company: s.company,
          domain: s.domain ?? (hostOf(scraped[s.index]?.url ?? "") || null),
          url: scraped[s.index]?.url ?? "",
          contact: s.contact,
          icp_score: s.icp_score,
          reason: s.reason,
          status: "pending_review",
        })),
        { onConflict: "store_id,url" },
      );
      if (error) throw new Error(`Leads upsert: ${error.message}`);
    }
    processed = fresh.length;
    const status: RunStatus = "done";
    const focusTag = focus ? ` · foco: ${focus.slice(0, 60)}` : "";
    await finishRun(runId, { status, processed, failed, summary: `${processed} leads propuestos · ${failed} fallidos${focusTag}` });
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed,
      failed,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
