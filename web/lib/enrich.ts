// Enriquecimiento de dominios (firmográficos). Server-only.
// La clave es el dominio: si ya existe fila en `domains`, no se re-scrapea.
import "server-only";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupabase } from "@/lib/supabase";
import { classifyDomain, domainFromEmail } from "@/lib/domains";
import { extractFirmographics } from "@/lib/ai/enrich";

const UA = "Mozilla/5.0 (compatible; RetainEngineBot/0.1)";
const FETCH_TIMEOUT_MS = 12_000;
const LOG_FILE = join(process.cwd(), ".data", "enrichment.log");

/** Log a consola + archivo (.data/enrichment.log). Best-effort en archivo. */
function log(line: string): void {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(`[enrich] ${msg}`);
  appendFile(LOG_FILE, msg + "\n", "utf-8").catch(() => {
    // Sin archivo de log: la consola ya lo tiene.
  });
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Home renderizado a texto (con fallback www). null si no se pudo obtener. */
async function fetchHomepage(domain: string): Promise<{ text: string; url: string } | null> {
  for (const url of [`https://${domain}`, `https://www.${domain}`]) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        log(`${domain} fetch ${url} → HTTP ${res.status}`);
        continue;
      }
      const text = htmlToText(await res.text());
      if (text.length < 40) {
        log(`${domain} fetch ${url} → texto insuficiente (${text.length})`);
        continue;
      }
      log(`${domain} fetch ${url} → ok (${text.length} chars)`);
      return { text, url: res.url || url };
    } catch (e) {
      log(`${domain} fetch ${url} → error ${e instanceof Error ? e.message : e}`);
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

  const page = await fetchHomepage(d);
  if (!page) return "failed";

  const cls = classifyDomain(d);
  const f = await extractFirmographics(d, page.text);
  const { error } = await db.from("domains").upsert(
    {
      domain: d,
      domain_type: cls.type === "institutional" ? "institutional" : "business",
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

// ---- Corridas en background (status en DB) ---------------------------------

export type RunStatus = "running" | "done" | "error";

export interface EnrichRunStatus {
  id: string;
  status: RunStatus;
  total: number;
  processed: number;
  failed: number;
  current: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function mapRun(r: Record<string, unknown>): EnrichRunStatus {
  return {
    id: String(r.id),
    status: (r.status as RunStatus) ?? "running",
    total: Number(r.total ?? 0),
    processed: Number(r.processed ?? 0),
    failed: Number(r.failed ?? 0),
    current: (r.current as string) ?? null,
    error: (r.error as string) ?? null,
    startedAt: String(r.started_at ?? ""),
    finishedAt: (r.finished_at as string) ?? null,
  };
}

export async function getLatestRun(storeId: string): Promise<EnrichRunStatus | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from("enrichment_runs")
    .select("*")
    .eq("store_id", storeId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Runs read: ${error.message}`);
  return data ? mapRun(data as Record<string, unknown>) : null;
}

export async function hasRunningRun(storeId: string): Promise<boolean> {
  const db = getSupabase();
  const { data, error } = await db
    .from("enrichment_runs")
    .select("id")
    .eq("store_id", storeId)
    .eq("status", "running")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Runs read: ${error.message}`);
  return Boolean(data);
}

export async function startRun(storeId: string, total: number): Promise<string> {
  const db = getSupabase();
  const { data, error } = await db
    .from("enrichment_runs")
    .insert({ store_id: storeId, total, status: "running" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Run insert: ${error?.message}`);
  return String(data.id);
}

/**
 * Procesa una lista de dominios y va actualizando el run en DB (progreso en vivo).
 * Corre en background (vía `after()`), desacoplado de la request del cliente.
 */
export async function runEnrichment(
  runId: string,
  domains: string[],
): Promise<void> {
  const db = getSupabase();
  let processed = 0;
  let failed = 0;
  log(`run ${runId} start total=${domains.length}`);

  for (const d of domains) {
    await db
      .from("enrichment_runs")
      .update({ current: d, processed, failed })
      .eq("id", runId);
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
  }

  const status: RunStatus = processed === 0 && failed > 0 ? "error" : "done";
  await db
    .from("enrichment_runs")
    .update({
      status,
      processed,
      failed,
      current: null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
  log(`run ${runId} ${status} processed=${processed} failed=${failed}`);
}
