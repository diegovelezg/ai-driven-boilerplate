// Capa de retrieval web compartida: queries LLM → SearXNG → scrape estático.
// La usan el perfilador (verticals, Fase A) y el prospector/enriquecedor.
// SIN "server-only" a propósito: el pipeline del perfilador debe cargar en
// scripts tsx (ver profiling/log.ts). El logging aquí es mínimo por diseño:
// los fallos se propagan como errores con contexto, cada llamador loguea.
import { join } from "node:path";
import { CheerioCrawler } from "@crawlee/cheerio";
import {
  chatCompletionParams,
  getLlmConfig,
  reasoningBody,
  type ModelRef,
} from "@/lib/ai/llm-config";

process.env.CRAWLEE_STORAGE_DIR ??= join(process.cwd(), ".data", "crawlee");

const SEARXNG_URL = (process.env.SEARXNG_URL ?? "http://localhost:8888").replace(/\/+$/, "");

/** Chat completion que devuelve JSON (lanza si la respuesta no es texto útil). */
export async function completeJson(
  ref: ModelRef,
  temp: number,
  maxTokens: number,
  effort: string | null,
  system: string,
  user: string,
): Promise<string> {
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

const QUERIES_SYSTEM =
  "Generas queries de búsqueda web para encontrar negocios parecidos al ICP. Responde SOLO JSON: {\"queries\": [string]}. Queries en español, variadas. Prefiere queries que devuelvan webs de empresas y directorios indexables; evita site:linkedin.com y redes sociales (muro de login, no scrapeables).";

/** Queries de búsqueda desde un ICP (3 intentos primario→fallback, como el prospector). */
export async function buildQueries(icp: string, n = 3, focus?: string | null): Promise<string[]> {
  const cfg = getLlmConfig("prospect_scan");
  const order = [cfg.primary, cfg.fallback, cfg.fallback].filter(
    (r): r is ModelRef => Boolean(r),
  );
  const user = `ICP:\n${icp.slice(0, 1500)}\n${focus ? `\nEnfoque de ESTA corrida (manda sobre lo general): ${focus}\n` : ""}\nNº de queries: ${n}`;
  let lastErr: unknown = null;
  let raw = "";
  for (let i = 0; i < order.length; i++) {
    try {
      raw = await completeJson(
        order[i],
        cfg.temperature,
        cfg.maxTokens,
        cfg.reasoningEffort,
        QUERIES_SYSTEM,
        user,
      );
      break;
    } catch (e) {
      lastErr = e;
      if (i < order.length - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!raw) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  const parsed = JSON.parse(raw) as { queries?: unknown };
  const qs = Array.isArray(parsed.queries)
    ? parsed.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    : [];
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

export function hostOf(url: string): string {
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
