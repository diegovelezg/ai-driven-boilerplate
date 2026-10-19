// Enriquecimiento de dominios (firmográficos). Server-only.
// La clave es el dominio: si ya existe fila en `domains`, no se re-scrapea.
import "server-only";
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { classifyDomain, domainFromEmail } from "@/lib/domains";
import { extractFirmographics } from "@/lib/ai/enrich";
import { judgeBusinessDomain, B2B_GATE_THRESHOLD } from "@/lib/ai/decisions";
import { searchSearxng, scrapable } from "@/lib/retrieval";
import { mapPool } from "@/lib/parallel";
import { applyScopeFilter, type MarketScope } from "@/lib/markets";
import { formatNumber } from "@/lib/format";

const UA = "Mozilla/5.0 (compatible; AIRetentionEngineBot/0.1)";
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
 * Todos los dominios registrados interesan (aunque tengan 0 compras): se
 * intenta rescue siempre.
 * Guard v1 (smoke 2026-10-16): host contiene etiqueta, o título contiene
 * etiqueta/empresa declarada. Denylist social vía `scrapable()` (retrieval).
 * Ambiguos (homónimos tipo servex0) se aceptan y quedan auditables por source_url.
 */
async function rescueDomain(
  domain: string,
  users: DomainUsers,
): Promise<{ text: string; url: string } | null> {
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

/**
 * Dominios de negocio/institucionales presentes entre los customers de la tienda
 * que aún no están resueltos en `domains`. Terminal = business/institutional/
 * personal, o unreachable con failed_attempts >= MAX_DOMAIN_ATTEMPTS.
 * Los unreachable con intentos restantes siguen pendientes (reintentan en la
 * próxima automática). (Se calcula en JS: PostgREST no hace split_part.)
 * TTL simple: un terminal con enriched_at >90d vuelve a pendiente una vez.
 */
const PENDING_TTL_MS = 5 * 60_000;
const REFRESH_AFTER_MS = 90 * 24 * 60 * 60_000;
const pendingCache = new Map<string, { at: number; data: string[] }>();
/** Users precargados en el mismo scan de pendingDomains (fusión: evita el
 *  segundo full-scan de batchDomainUsers). */
const usersCache = new Map<string, { at: number; users: Map<string, DomainUsers> }>();

function isFreshTerminal(enrichedAt: unknown): boolean {
  if (typeof enrichedAt !== "string" || !enrichedAt) return true;
  const ms = Date.parse(enrichedAt);
  if (Number.isNaN(ms)) return true;
  return Date.now() - ms <= REFRESH_AFTER_MS;
}

export async function pendingDomains(
  storeId: string,
  scope: Pick<MarketScope, "countries" | "customerIds"> | null = null,
): Promise<string[]> {
  const useCache = scope === null;
  const cacheKey = useCache ? `pending:${storeId}` : null;
  if (cacheKey) {
    const hit = pendingCache.get(cacheKey);
    if (hit && Date.now() - hit.at <= PENDING_TTL_MS) return hit.data;
  }
  const db = getSupabase();

  const domains = new Set<string>();
  // Acumulador de users en la misma pasada (fusión con batchDomainUsers).
  const acc = new Map<string, { emails: string[]; companies: string[]; buyers: number; total: number }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await applyScopeFilter(
      db.from("customers").select("email,company_name,orders_count").eq("store_id", storeId).order("id", { ascending: true }),
      scope,
      "id",
    ).range(from, from + 999);
    if (error) throw new Error(`Customers read: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const d = domainFromEmail(String(r.email ?? ""));
      if (!d || !classifyDomain(d).enrichable) continue;
      domains.add(d);
      if (useCache) {
        const e = acc.get(d) ?? { emails: [], companies: [], buyers: 0, total: 0 };
        e.total += 1;
        if (e.emails.length < 5) {
          const co = String(r.company_name ?? "").trim();
          e.emails.push(`- ${String(r.email ?? "")}${co ? ` (empresa: ${co})` : ""}`);
        }
        const co = String(r.company_name ?? "").trim();
        if (co && !e.companies.includes(co)) e.companies.push(co);
        if (Number(r.orders_count ?? 0) > 0) e.buyers += 1;
        acc.set(d, e);
      }
    }
    if (!data || data.length < 1000) break;
  }
  if (domains.size === 0) return [];

  const list = [...domains];
  const terminal = new Set<string>();
  for (let i = 0; i < list.length; i += 500) {
    // failed_attempts/last_error existen desde 20261016000016; si la migración
    // aún no se aplicó, se degrada al comportamiento anterior (toda fila = terminal).
    let rows: Array<Record<string, unknown>> | null = null;
    const attempt = await db
      .from("domains")
      .select("domain,domain_type,failed_attempts,enriched_at")
      .in("domain", list.slice(i, i + 500));
    if (attempt.error) {
      const fallback = await db
        .from("domains")
        .select("domain")
        .in("domain", list.slice(i, i + 500));
      if (fallback.error) throw new Error(`Domains read: ${fallback.error.message}`);
      for (const r of fallback.data ?? []) terminal.add(String((r as Record<string, unknown>).domain));
      continue;
    }
    rows = (attempt.data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const t = String(r.domain_type ?? "");
      const n = Number(r.failed_attempts ?? 0);
      // TTL: terminal viejo (>90d) se reabre una vez para refrescar ficha.
      if (!isFreshTerminal(r.enriched_at)) continue;
      if (t === "business" || t === "institutional" || t === "personal") {
        terminal.add(String(r.domain));
      } else if (t === "unreachable") {
        if (n >= MAX_DOMAIN_ATTEMPTS) terminal.add(String(r.domain));
      } else {
        terminal.add(String(r.domain));
      }
    }
  }
  const out = list.filter((d) => !terminal.has(d));
  if (cacheKey) {
    pendingCache.set(cacheKey, { at: Date.now(), data: out });
    // Users fusionados: batchDomainUsers los consume sin segundo scan.
    const users = new Map<string, DomainUsers>();
    for (const d of out) {
      const e = acc.get(d);
      if (!e) {
        users.set(d, { context: "", company: null, buyers: 0, full: true });
        continue;
      }
      users.set(d, {
        context: `Muestra de ${e.total} customer(s) con este dominio (${e.buyers} compradores):\n${e.emails.join("\n")}`,
        company: e.companies[0] ?? null,
        buyers: e.buyers,
        full: true,
      });
    }
    usersCache.set(cacheKey, { at: Date.now(), users });
  }
  return out;
}

export type EnrichDomainResult = "enriched" | "skipped" | "failed";

/** Evidencia local para el gate: muestra de emails + empresas que usan el dominio. */
export interface DomainUsers {
  context: string;
  company: string | null;
  buyers: number;
  /** true = conteo full (batch, un scan); false = ventana 20 (LIKE puntual). */
  full: boolean;
}

/** Invalida la caché de pending (tras resolver/fallar un dominio o sincronizar). */
export function invalidatePendingCache(storeId?: string): void {
  if (storeId) {
    pendingCache.delete(`pending:${storeId}`);
    usersCache.delete(`pending:${storeId}`);
    return;
  }
  pendingCache.clear();
  usersCache.clear();
}

/** Una sola pasada sobre customers para N dominios: reemplaza los N `LIKE
 *  '%@dom'` de `domainUsers` (sin índice de sufijo) por un scan paginado. */
export async function batchDomainUsers(
  storeId: string,
  domains: string[],
): Promise<Map<string, DomainUsers>> {
  const wanted = new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean));
  // Fusión: si pendingDomains corrió hace <5 min, los users ya están.
  const cached = usersCache.get(`pending:${storeId}`);
  if (cached && Date.now() - cached.at <= PENDING_TTL_MS) {
    let complete = true;
    for (const d of wanted) {
      if (!cached.users.has(d)) {
        complete = false;
        break;
      }
    }
    if (complete) {
      const out = new Map<string, DomainUsers>();
      for (const d of wanted) out.set(d, cached.users.get(d)!);
      return out;
    }
  }
  const acc = new Map<string, { emails: string[]; companies: string[]; buyers: number; total: number }>();
  if (wanted.size === 0) return new Map();
  const db = getSupabase();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("customers")
      .select("email,company_name,orders_count")
      .eq("store_id", storeId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`Customers read: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const d = domainFromEmail(String(r.email ?? ""));
      if (!d || !wanted.has(d)) continue;
      const e = acc.get(d) ?? { emails: [], companies: [], buyers: 0, total: 0 };
      e.total += 1;
      if (e.emails.length < 5) {
        const co = String(r.company_name ?? "").trim();
        e.emails.push(`- ${String(r.email ?? "")}${co ? ` (empresa: ${co})` : ""}`);
      }
      const co = String(r.company_name ?? "").trim();
      if (co && !e.companies.includes(co)) e.companies.push(co);
      if (Number(r.orders_count ?? 0) > 0) e.buyers += 1;
      acc.set(d, e);
    }
    if (!data || data.length < 1000) break;
  }
  const out = new Map<string, DomainUsers>();
  for (const d of wanted) {
    const e = acc.get(d);
    if (!e) {
      out.set(d, { context: "", company: null, buyers: 0, full: true });
      continue;
    }
    out.set(d, {
      context: `Muestra de ${e.total} customer(s) con este dominio (${e.buyers} compradores):\n${e.emails.join("\n")}`,
      company: e.companies[0] ?? null,
      buyers: e.buyers,
      full: true,
    });
  }
  return out;
}

async function domainUsers(domain: string): Promise<DomainUsers> {
  const esc = domain.replace(/[%_\\]/g, "\\$&");
  const { data, error, count } = await getSupabase()
    .from("customers")
    .select("email,company_name,orders_count", { count: "exact" })
    .like("email", `%@${esc}`)
    .limit(20);
  if (error || !data || data.length === 0) return { context: "", company: null, buyers: 0, full: false };
  const rows = data as Array<Record<string, unknown>>;
  const total = count ?? rows.length;
  const lines = rows.slice(0, 5).map((r) => {
    const co = String(r.company_name ?? "").trim();
    return `- ${String(r.email ?? "")}${co ? ` (empresa: ${co})` : ""}`;
  });
  const companies = [...new Set(rows.map((r) => String(r.company_name ?? "").trim()).filter(Boolean))];
  const buyersWindow = rows.filter((r) => Number(r.orders_count ?? 0) > 0).length;
  return {
    context: `Muestra de ${total} customer(s) con este dominio (${buyersWindow} compradores en la muestra):\n${lines.join("\n")}`,
    company: companies[0] ?? null,
    buyers: buyersWindow,
    full: false,
  };
}

/** Intentos fetch+rescue antes de marcar un dominio como terminal (unreachable). */
const MAX_DOMAIN_ATTEMPTS = 3;

/**
 * Persiste un fallo fetch+rescue: incrementa failed_attempts y guarda last_error.
 * A partir de MAX_DOMAIN_ATTEMPTS el dominio es terminal (sale del automático;
 * el reintento manual con force=true sigue posible).
 * Si la migración 20261016000016 aún no se aplicó, no persiste (comportamiento
 * anterior: el dominio seguirá pendiente).
 */
async function recordFailure(domain: string, lastError: string): Promise<number> {
  const db = getSupabase();
  let attempts = 1;
  try {
    const { data } = await db
      .from("domains")
      .select("failed_attempts")
      .eq("domain", domain)
      .maybeSingle();
    attempts = Number((data as Record<string, unknown> | null)?.failed_attempts ?? 0) + 1;
  } catch {
    return 1;
  }
  const { error } = await db.from("domains").upsert(
    {
      domain,
      domain_type: "unreachable",
      company_name: null,
      failed_attempts: attempts,
      last_error: lastError,
      enriched_at: new Date().toISOString(),
    },
    { onConflict: "domain" },
  );
  if (error) {
    log(`${domain} no se pudo persistir el fallo (${error.message}); seguirá pendiente`);
    return attempts;
  }
  return attempts;
}

/** Enriquece un dominio. `force` re-scrapea aunque ya exista. */
export async function enrichDomain(
  domain: string,
  force = false,
  usersOverride?: DomainUsers | null,
): Promise<EnrichDomainResult> {
  const d = domain.trim().toLowerCase();
  const db = getSupabase();

  if (!force) {
    // Fila terminal (enriquecido/personal/unreachable agotado) → skipped.
    // Unreachable con intentos restantes → se reintenta. TTL: terminal viejo
    // (>90d) se reabre (no se salta aquí; lo filtra pendingDomains).
    let row: Record<string, unknown> | null = null;
    try {
      const { data, error } = await db
        .from("domains")
        .select("domain,domain_type,failed_attempts,enriched_at")
        .eq("domain", d)
        .maybeSingle();
      if (error) throw new Error(`Domains read: ${error.message}`);
      row = (data as Record<string, unknown> | null) ?? null;
    } catch (e) {
      const { data, error } = await db
        .from("domains")
        .select("domain")
        .eq("domain", d)
        .maybeSingle();
      if (error) throw new Error(`Domains read: ${error.message}`);
      if (data) return "skipped";
      row = null;
      log(`${d} sin columnas de reintento (${e instanceof Error ? e.message : e}); se sigue`);
    }
    if (row) {
      const t = String(row.domain_type ?? "");
      const n = Number(row.failed_attempts ?? 0);
      if (isFreshTerminal(row.enriched_at)) {
        if (t === "business" || t === "institutional" || t === "personal") return "skipped";
        if (t === "unreachable" && n >= MAX_DOMAIN_ATTEMPTS) return "skipped";
        if (t !== "unreachable") return "skipped";
      }
    }
  }

  // PILOTO gate B2B (Decisions, con contexto local de quién usa el dominio):
  // corre ANTES del fetch para ahorrar fetch + extracción en dominios
  // personales/parqueados. Solo entra si el regex ya dijo `enrichable`.
  // Rechazo (p < umbral, sin calibrar) → fila 'personal' para no re-evaluar.
  // Sin veredicto (rehúse/error/sin key) → se sigue con extracción y se loguea.
  const cls0 = classifyDomain(d);
  log(`${d} capa=regex type=${cls0.type} enrichable=${cls0.enrichable}`);
  // Una sola pasada batch (runEnrichment prefiere batchDomainUsers); el LIKE
  // por dominio queda como respaldo para llamadas puntuales (drawer/script).
  const users = usersOverride ?? await domainUsers(d);
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
          failed_attempts: 0,
          last_error: null,
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
    // Sin compradores ni empresa declarada no se gasta rescue (searxng +
    // fetches): se registra el fallo y reintenta en la próxima (máx 3).
    // Solo con conteo full (batch): en ventana puntual un 0 no prueba nada.
    if (users.full && users.buyers === 0 && !users.company) {
      const attempts = await recordFailure(d, "fetch-directo sin éxito y sin compradores/empresa (rescue omitido)");
      const terminal = attempts >= MAX_DOMAIN_ATTEMPTS;
      log(`${d} → failed intento=${attempts}/${MAX_DOMAIN_ATTEMPTS} rescue-omitido ${terminal ? "terminal=unreachable" : "reintentable"}`);
      return "failed";
    }
    const rescued = await rescueDomain(d, users);
    if (!rescued) {
      const attempts = await recordFailure(d, "fetch-directo+rescue sin éxito (detalle en log)");
      const terminal = attempts >= MAX_DOMAIN_ATTEMPTS;
      log(`${d} → failed intento=${attempts}/${MAX_DOMAIN_ATTEMPTS} ${terminal ? "terminal=unreachable" : "reintentable"}`);
      return "failed";
    }
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
      failed_attempts: 0,
      last_error: null,
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
  opts: { storeId?: string | null } = {},
): Promise<void> {
  let processed = 0;
  let failed = 0;
  log(`run ${runId} start total=${domains.length} concurrency=${ENRICH_CONCURRENCY}`);

  // Una sola pasada de users para todo el lote (evita N LIKE '%@dom').
  let usersByDomain: Map<string, DomainUsers> | null = null;
  if (opts.storeId) {
    try {
      usersByDomain = await batchDomainUsers(opts.storeId, domains);
    } catch (e) {
      log(`run ${runId} batch users falló (${e instanceof Error ? e.message : e}); respaldo por dominio`);
    }
  }

  await mapPool(domains, ENRICH_CONCURRENCY, async (d) => {
    await advanceRun(runId, { processed, failed, current: d });
    try {
      const r = await enrichDomain(d, false, usersByDomain?.get(d.trim().toLowerCase()) ?? null);
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
  const summary = `${formatNumber(processed)} dominio${processed === 1 ? "" : "s"}${
    failed > 0 ? ` · ${formatNumber(failed)} fallidos` : ""
  }`;
  await finishRun(runId, { status, processed, failed, summary });
  log(`run ${runId} ${status} processed=${processed} failed=${failed}`);
}
