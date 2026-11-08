// Research de empresa por dominio(s): homepage → LLM firmographics → tabla `domains`.
// Candidatos: companies.domain + dominio de companies.email + dominios de emails
// de contactos (collectCandidateDomains) + fallback web por nombre si no hay nada.
import { getSupabase } from "@/lib/supabase";
import { extractFirmographics } from "@/lib/ai/enrich";
import {
  collectCandidateDomains,
  normalizeDomain,
  type DomainCandidate,
} from "@/lib/company-domains";

const UA = "Mozilla/5.0 (compatible; DoohBot/0.1)";
const FETCH_TIMEOUT_MS = 12_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHomepage(domain: string): Promise<{ text: string; url: string } | null> {
  for (const url of [`https://${domain}`, `https://www.${domain}`]) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const text = htmlToText(await res.text());
      if (text.length < 40) continue;
      return { text, url: res.url || url };
    } catch {
      continue;
    }
  }
  return null;
}

export interface DomainProfile {
  domain: string;
  domain_type: string | null;
  company_name: string | null;
  industry: string | null;
  description: string | null;
  size: string | null;
  location: string | null;
  source_url: string | null;
  model: string | null;
  confidence: number | null;
  enriched_at: string | null;
}

function mapProfile(domain: string, r: Record<string, unknown> | null): DomainProfile | null {
  if (!r) return null;
  return {
    domain,
    domain_type: (r.domain_type as string) ?? null,
    company_name: (r.company_name as string) ?? null,
    industry: (r.industry as string) ?? null,
    description: (r.description as string) ?? null,
    size: (r.size as string) ?? null,
    location: (r.location as string) ?? null,
    source_url: (r.source_url as string) ?? null,
    model: (r.model as string) ?? null,
    confidence: r.confidence == null ? null : Number(r.confidence),
    enriched_at: (r.enriched_at as string) ?? null,
  };
}

function isMissingTable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /could not find the table/i.test(msg) || (msg as string).includes("PGRST205");
}

export async function getDomainProfile(domain: string): Promise<DomainProfile | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const db = getSupabase();
  const { data, error } = await db.from("ai_domain_cache").select("*").eq("domain", d).maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(`Domains read: ${error.message}`);
  }
  if (!data) return null;
  return mapProfile(d, data as Record<string, unknown>);
}

export async function getDomainProfiles(domains: string[]): Promise<Map<string, DomainProfile>> {
  const out = new Map<string, DomainProfile>();
  const clean = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
  if (clean.length === 0) return out;
  const db = getSupabase();
  for (let i = 0; i < clean.length; i += 100) {
    const chunk = clean.slice(i, i + 100);
    const { data, error } = await db.from("ai_domain_cache").select("*").in("domain", chunk);
    if (error) {
      if (isMissingTable(error)) return out;
      throw new Error(`Domains read: ${error.message}`);
    }
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const d = String(r.domain ?? "");
      const p = mapProfile(d, r);
      if (p) out.set(d, p);
    }
  }
  return out;
}

export type ResearchStatus = "ok" | "cached" | "no-homepage" | "error";

/** Investiga un dominio y lo persiste en `domains` (upsert por PK).
 *  Caché global por diseño: solo guarda firmographics públicos de la homepage
 *  (company/industry/description/size/location/source/model/confidence).
 *  Nunca persiste emails de contactos ni PII del tenant (los candidatos por
 *  email solo derivan el dominio y se descartan). Por eso la lectura global
 *  `authenticated` no filtra por store_id. */
export async function researchDomain(
  domain: string,
  opts: { storeId?: string | null; force?: boolean } = {},
): Promise<{ status: ResearchStatus; profile: DomainProfile | null; error?: string }> {
  const d = normalizeDomain(domain);
  if (!d) return { status: "error", profile: null, error: "Dominio inválido." };
  const db = getSupabase();
  if (!opts.force) {
    const cached = await getDomainProfile(d).catch(() => null);
    if (cached) return { status: "cached", profile: cached };
  }
  const page = await fetchHomepage(d);
  if (!page) return { status: "no-homepage", profile: await getDomainProfile(d).catch(() => null) };
  let firm: Awaited<ReturnType<typeof extractFirmographics>>;
  try {
    firm = await extractFirmographics(d, page.text, opts.storeId ? { storeId: opts.storeId } : {});
  } catch (e) {
    return { status: "error", profile: null, error: e instanceof Error ? e.message : "LLM falló." };
  }
  const { error } = await db.from("ai_domain_cache").upsert(
    {
      domain: d,
      domain_type: "business",
      company_name: firm.companyName,
      industry: firm.industry,
      description: firm.description,
      size: firm.size,
      location: firm.location,
      source_url: page.url,
      model: firm.model,
      confidence: firm.confidence,
      enriched_at: new Date().toISOString(),
    },
    { onConflict: "domain" },
  );
  if (error) {
    if (isMissingTable(error)) {
      return {
        status: "error",
        profile: null,
        error: "Falta la tabla domains: aplicar supabase/migrations (20261123) al contenedor supabase-db.",
      };
    }
    return { status: "error", profile: null, error: `Domains upsert: ${error.message}` };
  }
  return { status: "ok", profile: await getDomainProfile(d).catch(() => null) };
}

export interface CompanyResearchInput {
  name: string;
  domain: string | null;
  email: string | null;
  country: string | null;
  contacts: Array<{ email: string | null }>;
}

/** Candidatos para una empresa + perfiles ya guardados. Incluye fallback web. */
export async function describeCompanyCandidates(input: CompanyResearchInput): Promise<{
  candidates: DomainCandidate[];
  profiles: DomainProfile[];
  discoveredFromWeb: string | null;
}> {
  let candidates = collectCandidateDomains(
    { domain: input.domain, email: input.email },
    input.contacts,
  );
  let discoveredFromWeb: string | null = null;

  if (candidates.length === 0) {
    const found = await discoverDomainFromWeb(input.name, input.country).catch(() => null);
    if (found) {
      discoveredFromWeb = found;
      candidates = [{ domain: found, source: "web", count: 1 }];
    }
  }
  const profiles = [...(await getDomainProfiles(candidates.map((c) => c.domain))).values()];
  return { candidates, profiles, discoveredFromWeb };
}

/** Fallback: SearXNG por nombre → primer host scrapeable (descubierto, no inventado). */
export async function discoverDomainFromWeb(name: string, country: string | null): Promise<string | null> {
  const q = `${name} empresa ${country === "PE" ? "Perú" : (country ?? "")} sitio oficial`.trim();
  if (q.replace(/\s/g, "").length < 6) return null;
  const { searchSearxng, rankHits, hostOf, scrapable } = await import("@/lib/retrieval");
  const hits = await searchSearxng(q, 5);
  const ranked = rankHits(hits);
  const { ok } = scrapable(ranked.map((h) => h.url));
  for (const u of ok) {
    const h = hostOf(u);
    const d = normalizeDomain(h);
    if (!d) continue;
    const { isEnrichableDomain } = await import("@/lib/company-domains");
    if (isEnrichableDomain(d)) return d;
  }
  return null;
}
