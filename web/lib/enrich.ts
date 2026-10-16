// Enriquecimiento de dominios (firmográficos). Server-only.
// La clave es el dominio: si ya existe fila en `domains`, no se re-scrapea.
import "server-only";
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { classifyDomain, domainFromEmail } from "@/lib/domains";
import { extractFirmographics } from "@/lib/ai/enrich";
import { judgeBusinessDomain, B2B_GATE_THRESHOLD } from "@/lib/ai/decisions";
import { searchSearxng, scrapable } from "@/lib/prospect";
import { mapPool } from "@/lib/parallel";

const UA = "Mozilla/5.0 (compatible; RetainEngineBot/0.1)";
// Sitios legítimos responden en <3s (medido); colgados = muertos. 8s acota el
// peor caso a 16s/dominio (era 24s) sin recortar éxitos reales.
const FETCH_TIMEOUT_MS = 8_000;

/** Log a consola + archivo (.data/enrichment.log). Formato grep-friendly: `dominio capa=X k=v…`. */
const log = createLogger("enrichment");

const now = (): number => Date.now();

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Home renderizado a texto (apex → www). Sin adivinanzas de TLD: si el dominio
 * no resuelve o el servidor responde, ese es el veredicto (regla general;
 * casos particulares tipo .pe→.com no se implementan).
 */
type FetchOutcome =
  | { kind: "ok"; text: string; url: string; title: string }
  | { kind: "http"; status: number; chars: number }
  | { kind: "net"; message: string };

function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]{0,200})<\/title>/i);
  return (m?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Fetch con un reintento ante rate-limit transitorio (403/429/5xx). */
async function tryFetch(url: string): Promise<FetchOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const html = await res.text();
      const text = htmlToText(html);
      if ((!res.ok || text.length < 40) && [403, 429, 500, 502, 503].includes(res.status) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (!res.ok || text.length < 40) return { kind: "http", status: res.status, chars: text.length };
      return { kind: "ok", text, url: res.url || url, title: pageTitle(html) };
    } catch (e) {
      return { kind: "net", message: e instanceof Error ? e.message : String(e) };
    }
  }
  return { kind: "http", status: -1, chars: 0 };
}

async function fetchHomepage(domain: string): Promise<{ text: string; url: string } | null> {
  for (const url of [`https://${domain}`, `https://www.${domain}`]) {
    const r = await tryFetch(url);
    if (r.kind === "http") {
      log(`${domain} fetch ${url} → HTTP ${r.status} (${r.chars} chars)`);
      continue;
    }
    if (r.kind === "ok") {
      log(`${domain} fetch ${url} → ok (${r.text.length} chars)`);
      return { text: r.text, url: r.url };
    }
    log(`${domain} fetch ${url} → error de red/DNS (${r.message})`);
  }
  return null;
}

/** País hint por TLD para las queries del rescue (dato general, no casos). */
const TLD_COUNTRY: Record<string, string> = {
  pe: "Perú",
  mx: "México",
  co: "Colombia",
  ec: "Ecuador",
  cl: "Chile",
  ar: "Argentina",
  bo: "Bolivia",
  es: "España",
  br: "Brasil",
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Capa 3 (rescue): si el fetch directo falló, buscar el negocio en la web con
 * queries deterministas y verificar identidad (guard v1) antes de extraer.
 * Solo para dominios con compradores (filtro de valor): el resto muere en failed.
 * Guard v1 (smoke 2026-10-16): host contiene etiqueta, o título contiene
 * etiqueta/empresa declarada. Denylist social vía `scrapable()` (prospector).
 * Ambiguos (homónimos tipo servex0) se aceptan y quedan auditables por source_url.
 */
async function rescueDomain(
  domain: string,
  users: DomainUsers,
): Promise<{ text: string; url: string } | null> {
  if (users.buyers === 0) {
    log(`${domain} capa=rescue veredicto=saltado-sin-compradores`);
    return null;
  }
  const label = domain.split(".")[0].toLowerCase();
  const tld = domain.split(".").pop()?.toLowerCase() ?? "";
  const Label = label.length > 0 ? label[0].toUpperCase() + label.slice(1) : label;
  const country = TLD_COUNTRY[tld];
  const queries = [...new Set([users.company, country ? `${Label} ${country}` : null, Label].filter((q): q is string => !!q && q.trim().length > 0))].slice(0, 3);
  const coLower = (users.company ?? "").toLowerCase();
  for (const q of queries) {
    log(`${domain} capa=rescue query="${q}"`);
    let hits: Array<{ url: string }>;
    try {
      hits = await searchSearxng(q, 5);
    } catch (e) {
      log(`${domain} capa=rescue query="${q}" search-fallo (${e instanceof Error ? e.message : e})`);
      continue;
    }
    const { ok } = scrapable(hits.map((h) => h.url));
    // Candidatos en paralelo (acotado a 3): se evalúa el guard en orden y gana
    // el primero verificado. Sin esto, 3 colgados en serie = 3× timeout.
    const cands = ok.slice(0, 3);
    const fetched = await Promise.all(cands.map(async (url) => ({ url, r: await tryFetch(url) })));
    for (const { url, r } of fetched) {
      if (r.kind !== "ok") {
        log(`${domain} capa=rescue candidato=${url} veredicto=descartado-fetch`);
        continue;
      }
      const host = hostOf(r.url || url);
      const titleLower = r.title.toLowerCase();
      const same =
        host.includes(label) ||
        titleLower.includes(label) ||
        (coLower !== "" && (titleLower.includes(coLower) || r.text.toLowerCase().includes(coLower)));
      if (!same) {
        log(`${domain} capa=rescue candidato=${url} veredicto=descartado-identidad`);
        continue;
      }
      log(`${domain} capa=rescue candidato=${url} veredicto=mismo-negocio chars=${r.text.length}`);
      return { text: r.text, url: r.url };
    }
  }
  return null;
}

export interface EnrichSummary {
  processed: number;
  failed: number;
  remaining: number;
}

/**
 * Dominios de negocio/institucionales presentes entre los customers de la tienda
 * que aún no tienen fila en `domains`. (Se calcula en JS: PostgREST no hace split_part.)
 */
export async function pendingDomains(storeId: string): Promise<string[]> {
  const db = getSupabase();

  const domains = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("customers")
      .select("email")
      .eq("store_id", storeId)
      .range(from, from + 999);
    if (error) throw new Error(`Customers read: ${error.message}`);
    for (const r of data ?? []) {
      const d = domainFromEmail(String(r.email ?? ""));
      if (d && classifyDomain(d).enrichable) domains.add(d);
    }
    if (!data || data.length < 1000) break;
  }
  if (domains.size === 0) return [];

  const list = [...domains];
  const existing = new Set<string>();
  for (let i = 0; i < list.length; i += 500) {
    const { data, error } = await db
      .from("domains")
      .select("domain")
      .in("domain", list.slice(i, i + 500));
    if (error) throw new Error(`Domains read: ${error.message}`);
    for (const r of data ?? []) existing.add(String(r.domain));
  }
  return list.filter((d) => !existing.has(d));
}

export type EnrichDomainResult = "enriched" | "skipped" | "failed";

/** Evidencia local para el gate: muestra de emails + empresas que usan el dominio. */
interface DomainUsers {
  context: string;
  company: string | null;
  buyers: number;
}

async function domainUsers(domain: string): Promise<DomainUsers> {
  const esc = domain.replace(/[%_\\]/g, "\\$&");
  const { data, error } = await getSupabase()
    .from("customers")
    .select("email,company_name,orders_count")
    .like("email", `%@${esc}`)
    .limit(20);
  if (error || !data || data.length === 0) return { context: "", company: null, buyers: 0 };
  const rows = data as Array<Record<string, unknown>>;
  const lines = rows.slice(0, 5).map((r) => {
    const co = String(r.company_name ?? "").trim();
    return `- ${String(r.email ?? "")}${co ? ` (empresa: ${co})` : ""}`;
  });
  const companies = [...new Set(rows.map((r) => String(r.company_name ?? "").trim()).filter(Boolean))];
  return {
    context: `${rows.length} customer(s) con este dominio:\n${lines.join("\n")}`,
    company: companies[0] ?? null,
    buyers: rows.filter((r) => Number(r.orders_count ?? 0) > 0).length,
  };
}

/** Enriquece un dominio. `force` re-scrapea aunque ya exista. */
export async function enrichDomain(
  domain: string,
  force = false,
): Promise<EnrichDomainResult> {
  const d = domain.trim().toLowerCase();
  const db = getSupabase();

  if (!force) {
    const { data, error } = await db
      .from("domains")
      .select("domain")
      .eq("domain", d)
      .maybeSingle();
    if (error) throw new Error(`Domains read: ${error.message}`);
    if (data) return "skipped";
  }

  // PILOTO gate B2B (Decisions, con contexto local de quién usa el dominio):
  // corre ANTES del fetch para ahorrar fetch + extracción en dominios
  // personales/parqueados. Solo entra si el regex ya dijo `enrichable`.
  // Rechazo (p < umbral, sin calibrar) → fila 'personal' para no re-evaluar.
  // Sin veredicto (rehúse/error/sin key) → se sigue con extracción y se loguea.
  const cls0 = classifyDomain(d);
  log(`${d} capa=regex type=${cls0.type} enrichable=${cls0.enrichable}`);
  const users = await domainUsers(d);
  const tGate = now();
  try {
    const v = await judgeBusinessDomain(d, users.context);
    log(`${d} capa=gate p=${v.probability.toFixed(2)} umbral=${B2B_GATE_THRESHOLD} veredicto=${v.isBusiness === null ? "sin-veredicto" : v.isBusiness ? "negocio" : "personal"} ms=${now() - tGate}`);
    if (v.isBusiness === false) {
      const { error } = await db.from("domains").upsert(
        {
          domain: d,
          domain_type: "personal",
          company_name: null,
          model: "openai/gpt-6-luna:gate",
          confidence: v.probability,
          enriched_at: new Date().toISOString(),
        },
        { onConflict: "domain" },
      );
      if (error) throw new Error(`Domains upsert: ${error.message}`);
      log(`${d} → descartado por gate (personal)`);
      return "skipped";
    }
  } catch (e) {
    log(`${d} gate sin veredicto (${e instanceof Error ? e.message : e}); se sigue`);
  }

  const tFetch = now();
  let page = await fetchHomepage(d);
  if (!page) {
    log(`${d} capa=fetch resultado=fallo ms=${now() - tFetch}`);
    const rescued = await rescueDomain(d, users);
    if (!rescued) return "failed";
    page = rescued;
  } else {
    log(`${d} capa=fetch url=${page.url} chars=${page.text.length} ms=${now() - tFetch}`);
  }

  const tExtract = now();
  const f = await extractFirmographics(d, page.text);
  log(`${d} capa=extract model=${f.model} company=${f.companyName ?? "null"} confidence=${f.confidence ?? "null"} ms=${now() - tExtract}`);
  const { error } = await db.from("domains").upsert(
    {
      domain: d,
      domain_type: cls0.type === "institutional" ? "institutional" : "business",
      company_name: f.companyName,
      industry: f.industry,
      description: f.description,
      size: f.size,
      location: f.location,
      source_url: page.url,
      model: f.model,
      confidence: f.confidence,
      enriched_at: new Date().toISOString(),
    },
    { onConflict: "domain" },
  );
  if (error) throw new Error(`Domains upsert: ${error.message}`);
  log(`${d} → enriquecido (${f.companyName ?? "sin nombre"})`);
  return "enriched";
}

/**
 * Procesa una lista de dominios y va actualizando el run en DB (progreso en vivo).
 * Corre en background (vía `after()`), desacoplado de la request del cliente.
 * Paralelo vía `mapPool` (los dominios son independientes).
 */
const ENRICH_CONCURRENCY = 5;

export async function runEnrichment(
  runId: string,
  domains: string[],
): Promise<void> {
  let processed = 0;
  let failed = 0;
  log(`run ${runId} start total=${domains.length} concurrency=${ENRICH_CONCURRENCY}`);

  await mapPool(domains, ENRICH_CONCURRENCY, async (d) => {
    await advanceRun(runId, { processed, failed, current: d });
    try {
      const r = await enrichDomain(d);
      if (r === "failed") {
        failed += 1;
        log(`run ${runId} ${d} → failed`);
      } else {
        processed += 1;
      }
    } catch (e) {
      failed += 1;
      log(`run ${runId} ${d} → ERROR ${e instanceof Error ? e.message : e}`);
    }
  });

  const status: RunStatus = processed === 0 && failed > 0 ? "error" : "done";
  const summary = `${processed} dominio${processed === 1 ? "" : "s"}${
    failed > 0 ? ` · ${failed} fallidos` : ""
  }`;
  await finishRun(runId, { status, processed, failed, summary });
  log(`run ${runId} ${status} processed=${processed} failed=${failed}`);
}
