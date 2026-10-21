// Capa de retrieval web compartida: queries LLM → SearXNG → scrape estático.
// La usan el perfilador (verticals, Fase A) y el prospector/enriquecedor.
// SIN "server-only" a propósito: el pipeline del perfilador debe cargar en
// scripts tsx (ver profiling/log.ts). El logging aquí es mínimo por diseño:
// los fallos se propagan como errores con contexto, cada llamador loguea.
import { accessSync, constants, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheerioCrawler } from "@crawlee/cheerio";
import {
  chatCompletionParams,
  getLlmConfig,
  reasoningBody,
  type ModelRef,
} from "@/lib/ai/llm-config";

/**
 * Primer directorio creable de la lista (puro salvo `create`, inyectable en
 * tests). Crawlee crea su storage con mkdir y propaga el error: si `.data`
 * no es escribible (p. ej. `/app` root-owned en la imagen Docker con
 * `USER nextjs`), `crawler.run()` revienta con `EACCES … mkdir '/app/.data'`
 * y toda la prospección cae. El storage es caché efímera: caer a tmpdir es
 * seguro. Exportado para tests.
 */
export function firstWritableDir(
  candidates: string[],
  // mkdir de un dir que ya existe no falla aunque sea read-only: hay que
  // comprobar escritura real con accessSync(W_OK), no solo la creación.
  create: (dir: string) => void = (dir) => {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  },
): string {
  for (const dir of candidates) {
    try {
      create(dir);
      return dir;
    } catch {
      // Siguiente candidato.
    }
  }
  return candidates[candidates.length - 1] ?? join(tmpdir(), "retain-crawlee");
}

process.env.CRAWLEE_STORAGE_DIR ??= firstWritableDir([
  join(process.cwd(), ".data", "crawlee"),
  join(tmpdir(), "retain-crawlee"),
]);

const SEARXNG_RAW = (process.env.SEARXNG_URL ?? "").trim();
const SEARXNG_URL = (SEARXNG_RAW || "http://localhost:8888").replace(/\/+$/, "");

/** Chat completion que devuelve JSON (lanza si la respuesta no es texto útil).
 *  Metering issue #15: con `meter.storeId` loguea usage en `llm_usage`
 *  (fire-and-forget, nunca bloquea). Sin storeId solo advierte en el insert. */
export async function completeJson(
  ref: ModelRef,
  temp: number,
  maxTokens: number,
  effort: string | null,
  system: string,
  user: string,
  meter?: { storeId?: string | null; process?: string; usedFallback?: boolean },
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
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      // Sin timeout el caller se queda colgado para siempre (botón en
      // "Cambiando…" sin toast). 120s cubre reasoning lento; el abortado
      // baja como error honesto, no como silencio.
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`${ref.provider}: timeout (120s) sin respuesta del modelo`);
    }
    throw e;
  }
  if (!res.ok) throw new Error(`${ref.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (meter?.storeId) {
    const { parseChatUsage, logLlmUsage } = await import("@/lib/ai/usage");
    const usage = parseChatUsage(data);
    if (usage) {
      void logLlmUsage({
        storeId: meter.storeId,
        process: meter.process ?? "prospect_scan",
        provider: ref.provider,
        model: ref.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
        latencyMs: Date.now() - t0,
        usedFallback: meter.usedFallback ?? false,
      });
    }
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    const fr = data?.choices?.[0]?.finish_reason ?? "?";
    const u = data?.usage?.completion_tokens_details ?? data?.usage ?? null;
    throw new Error(`${ref.provider}: respuesta vacía (finish=${fr} usage=${JSON.stringify(u)})`);
  }
  return content;
}

const QUERIES_SYSTEM =
  "Generas queries de búsqueda web para encontrar negocios parecidos al ICP. Responde SOLO JSON: {\"queries\": [string]}. REGLAS: 1 tema por query (una industria O un producto top O una marca, nunca mezcles 3 industrias en una query); 6-12 palabras; incluye Perú o una ciudad (Lima/Arequipa/Cusco) cuando el ICP sea peruano; añade una señal de web oficial (\"sitio oficial\", \"contacto\", \"nosotros\"); evita operadores menos (-) y comillas excesivas (SearXNG los penaliza); prefiere queries que devuelvan webs de empresas y directorios indexables; evita site:linkedin.com y redes sociales (muro de login, no scrapeables).";

/** Queries de búsqueda desde un ICP (3 intentos primario→fallback, como el prospector). */
export async function buildQueries(icp: string, n = 3, focus?: string | null, meter?: { storeId?: string | null }): Promise<string[]> {
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
        meter?.storeId ? { storeId: meter.storeId, process: "prospect_scan", usedFallback: i > 0 } : undefined,
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
  let res: Response;
  try {
    // SearXNG local: 30s sobra; sin timeout cuelga el pipeline si el contenedor se cuelga.
    res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error("SearXNG: timeout (30s) sin respuesta");
    }
    throw e;
  }
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
  /** Contactos públicos detectados por regex/href (determinista, sin LLM). */
  contacts: LeadContacts;
}

export interface LeadSocial {
  network: string;
  url: string;
}

export interface LeadContacts {
  emails: string[];
  phones: string[];
  socials: LeadSocial[];
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_CAND_RE = /(\+?\d[\d\s\-().]{6,}\d)/g;
const SOCIAL_HOSTS: Array<{ match: string; network: string }> = [
  { match: "facebook.com", network: "facebook" },
  { match: "instagram.com", network: "instagram" },
  { match: "tiktok.com", network: "tiktok" },
  { match: "linkedin.com", network: "linkedin" },
  { match: "youtube.com", network: "youtube" },
  { match: "youtu.be", network: "youtube" },
  { match: "x.com", network: "x" },
  { match: "twitter.com", network: "x" },
];

function cleanEmail(e: string): string | null {
  let v = e.trim().toLowerCase();
  if (v.length < 5 || v.length > 120) return null;
  if (/\.(png|jpe?g|gif|svg|webp|css|js|ico)$/.test(v)) return null;
  if (v.startsWith("noreply@") || v.startsWith("no-reply@")) return null;
  // Despega teléfonos pegados al local-part ("8357bela@" → "bela@").
  const at = v.lastIndexOf("@");
  if (at > 0) {
    const local = v.slice(0, at).replace(/^\d{3,}/, "");
    if (!local) return null;
    v = `${local}${v.slice(at)}`;
  }
  // Despega palabras pegadas al TLD (".peventas" → ".pe").
  v = v.replace(/(\.(?:pe|com|org|net|io|es|gob\.pe))[a-z]{2,}$/, "$1");
  if (v.length < 5 || v.length > 100) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,6}$/.test(v)) return null;
  return v;
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

function cleanPhone(p: string, opts?: { bareOk?: boolean }): string | null {
  // Paréntesis de formato ("(01) 4062099", "+51) 994032214") → espacios.
  const v = p.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  if (v.length < 7 || v.length > 30) return null;
  // Descarta fechas/versiones/rangos de años (no son teléfonos).
  if (/\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/.test(v)) return null;
  if (/\d+\.\d+\.\d+/.test(v)) return null;
  if (/^\d{4}\s*[-–]\s*\d{4}$/.test(v)) return null;
  const d = digitsOf(v);
  if (d.length < 7 || d.length > 15) return null;
  // Placeholders ("999999999") y secuencias pegadas sin prefijo.
  if (/^(\d)\1{6,}$/.test(d)) return null;
  // Texto libre sin separadores ni "+": solo fijos cortos o celulares PE (9…).
  // Así caen contadores ("671001451") y pegados sin prefijo.
  if (!opts?.bareOk) {
    const hasSep = /[\s\-().]/.test(v) || v.startsWith("+");
    if (!hasSep) {
      if (d.length === 9 && !d.startsWith("9")) return null;
      if (d.length > 9) return null;
    }
    // Texto sin "+" con más de 11 dígitos seguidos: casi siempre dos números pegados.
    if (!v.startsWith("+") && d.length > 11) return null;
  }
  return v.startsWith("+") ? v : d.length >= 9 && opts?.bareOk ? `+${d}` : v;
}

/** Extracción determinista de contactos públicos desde texto completo + hrefs.
 *  Pura y testeable: no requiere Cheerio ni red. Máx 3 emails / 3 tels / 6 RRSS. */
export function extractLeadContacts(input: { text: string; hrefs: string[] }): LeadContacts {
  const emails: string[] = [];
  const seenEmail = new Set<string>();
  const phones: string[] = [];
  const seenPhone = new Set<string>();
  const socials: LeadSocial[] = [];
  const seenSocial = new Set<string>();

  const pushEmail = (raw: string) => {
    const c = cleanEmail(raw);
    if (!c || seenEmail.has(c)) return;
    seenEmail.add(c);
    if (emails.length < 3) emails.push(c);
  };
  const pushPhone = (raw: string, bareOk = false) => {
    const c = cleanPhone(raw, { bareOk });
    if (!c) return;
    const d = digitsOf(c);
    // Dedupe por últimos 7 dígitos: "+51977605014", "977 605 014" y
    // "01) 4062099"/"+514062099" son el mismo número en distinto formato.
    const key = d.length > 7 ? d.slice(-7) : d;
    if (seenPhone.has(key)) return;
    seenPhone.add(key);
    if (phones.length < 3) phones.push(c);
  };
  const pushSocial = (network: string, url: string) => {
    let u = url.trim().slice(0, 300);
    if (!u.startsWith("http")) return;
    const low = u.toLowerCase();
    // Ruido: botones share/intent y posts sueltos, no perfiles del negocio.
    if (/sharer\.php|\/intent\/tweet|sdkpreparse/.test(low)) return;
    let parsed: URL | null = null;
    try {
      parsed = new URL(u);
    } catch {
      return;
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    if (network === "instagram" && /^\/p(\/|$)/.test(path)) return;
    if (path === "" && ["facebook", "x"].includes(network)) return; // raíz sin página
    if (network === "whatsapp") {
      // Normaliza wa.me/api.whatsapp al número: dos links al mismo número = uno.
      const digits = (u.match(/phone=(\+?\d[\d\s\-().]{6,}\d)|wa\.me\/(\+?\d[\d\s\-.()]{6,}\d)/i) ?? []).slice(1).find(Boolean);
      const d = digits ? digitsOf(digits) : "";
      if (d) u = `https://wa.me/${d}`;
    } else {
      u = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}`;
    }
    const key = `${network}|${u.toLowerCase()}`;
    if (seenSocial.has(key)) return;
    seenSocial.add(key);
    if (socials.length < 6) socials.push({ network, url: u });
  };

  for (const h of input.hrefs ?? []) {
    let href = String(h ?? "").trim();
    if (!href) continue;
    // tel: con espacios codificados ("tel:997%20278%20915") pegaba los dígitos.
    try {
      href = decodeURIComponent(href);
    } catch {
      // se usa crudo
    }
    const low = href.toLowerCase();
    if (low.startsWith("mailto:")) {
      const addr = href.slice(7).split("?")[0];
      for (const part of addr.split(",")) pushEmail(part);
      continue;
    }
    if (low.startsWith("tel:") || low.startsWith("callto:")) {
      pushPhone(href.replace(/^(mailto:|tel:|callto:)/i, "").split("?")[0], true);
      continue;
    }
    // WhatsApp con número → teléfono + social.
    const wa = href.match(/(?:wa\.me|api\.whatsapp\.com\/send|whatsapp\.com.*phone=)[^\d]*(\+?\d[\d\s\-().]{6,}\d)/i);
    if (wa?.[1]) {
      pushPhone(wa[1], true);
      pushSocial("whatsapp", href.startsWith("http") ? href : `https://${href}`);
      continue;
    }
    try {
      const host = new URL(href.startsWith("http") ? href : `https://${href}`).hostname
        .replace(/^www\./, "")
        .toLowerCase();
      for (const s of SOCIAL_HOSTS) {
        if (host === s.match || host.endsWith(`.${s.match}`)) {
          pushSocial(s.network, href.startsWith("http") ? href : `https://${href}`);
          break;
        }
      }
    } catch {
      // href relativo/no-URL: se ignora para RRSS
    }
  }

  const text = String(input.text ?? "");
  for (const m of text.match(EMAIL_RE) ?? []) pushEmail(m);
  for (const m of text.match(PHONE_CAND_RE) ?? []) {
    // Evita captar el local-part de un email ya visto como "teléfono".
    if (m.includes("@")) continue;
    pushPhone(m);
  }
  return { emails, phones, socials };
}

/** Mejor contacto único para la columna legada `contact` (email > teléfono). */
export function pickLeadContact(c: LeadContacts | null | undefined): string | null {
  if (!c) return null;
  return c.emails[0] ?? c.phones[0] ?? null;
}

/** Contacto válido = SOLO email o teléfono público. El LLM a veces devuelve
 *  nombres de personas ("Luis Cueva") o cargos: eso se descarta a null para
 *  que entre el fallback determinista (email > teléfono del scrape). */
export function sanitizeLeadContact(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().slice(0, 200);
  if (!v) return null;
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(v)) {
    const m = v.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? m[0].toLowerCase() : null;
  }
  const digits = v.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  // Teléfono: sin letras (nombres/cargos traen letras sin @ ni 7 dígitos útiles).
  if (/[a-záéíóúñ]/i.test(v)) return null;
  if (!/[\d\s\-()+.]/.test(v)) return null;
  return v.replace(/\s+/g, " ").trim();
}

/** Scrape estático (Cheerio, sin browser): suficiente para webs de empresas y directorios.
 *  El texto principal excluye nav/footer/header (ruido), pero los contactos se
 *  extraen ANTES con el body completo + hrefs (mailto:/tel:/RRSS). */
export async function scrapeCandidates(urls: string[]): Promise<Scraped[]> {
  const out: Scraped[] = [];
  const crawler = new CheerioCrawler({
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 25,
    async requestHandler({ $, request }) {
      // Texto completo CON límites entre elementos: .text() pega spans
      // adyacentes ("8357" + "bela@..." + "ventas@...") y el regex de email
      // se come dos contactos en uno. Para el texto principal se sigue
      // excluyendo nav/footer/header (ruido); los contactos usan el completo.
      const fullHtml = $("body").html() ?? "";
      const fullText = fullHtml
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/(p|div|li|tr|h[1-6]|span|a)>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 12000);
      const hrefs: string[] = ($("a[href]")
        .map((_, el) => $(el).attr("href") ?? "")
        .get() as string[]).slice(0, 300);
      const contacts = extractLeadContacts({ text: fullText, hrefs });
      $("script,style,nav,footer,header,noscript,iframe").remove();
      const raw = ($("article").text() || $("main").text() || $("body").text() || "").replace(/\s+/g, " ").trim();
      if (raw.length < 200) return; // pared de login/bot o página vacía: se descarta en silencio
      out.push({ url: request.url, title: $("title").first().text().trim().slice(0, 200), text: raw.slice(0, 4000), contacts });
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

/** Dominios no scrapeables (login/bot wall + documentales que nunca son leads). */
const UNSCRAPABLE = [
  "linkedin.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com",
  "scribd.com", "studocu.com", "issuu.com", "slideshare.net", "docplayer.es", "vdocuments.mx",
  "youtube.com", "youtu.be", "mercadolibre.com", "facebook.net",
];

/** ¿URL con pinta de documento (PDF/presentación), no web de empresa? */
function looksLikeDoc(url: string): boolean {
  const low = url.toLowerCase().split("?")[0];
  return /\.(pdf|pptx?|xlsx?|docx?|csv)(\/|$)/.test(low) || /\/document\/|\/doc\/\d+|\/docs\//.test(low);
}

export function scrapable(urls: string[]): { ok: string[]; skipped: number } {
  const ok = urls.filter((u) => {
    if (looksLikeDoc(u)) return false;
    const h = hostOf(u);
    return h && !UNSCRAPABLE.some((d) => h === d || h.endsWith(`.${d}`));
  });
  return { ok, skipped: urls.length - ok.length };
}

/** Preferencia de webs de empresa para ordenar hits antes del scrape:
 *  .pe primero, luego dominios con pinta comercial, al final el resto. */
export function rankHits<T extends { url: string }>(hits: T[]): T[] {
  const score = (u: string): number => {
    const h = hostOf(u).toLowerCase();
    if (!h) return 0;
    if (h.endsWith(".pe")) return 3;
    if (h.endsWith(".com")) return 2;
    if (looksLikeDoc(u)) return -1;
    return 1;
  };
  return [...hits].sort((a, b) => score(b.url) - score(a.url));
}
