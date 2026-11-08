import { getSupabase } from "@/lib/supabase";
import { requireStoreAccess } from "@/lib/api/guard";
import { normalizeDomain } from "@/lib/company-domains";
import {
  describeCompanyCandidates,
  discoverDomainFromWeb,
  getDomainProfiles,
  researchDomain,
} from "@/lib/company-research";

async function loadCompanyContext(storeId: string, id: string) {
  const db = getSupabase();
  const { data: company, error } = await db
    .from("crm_companies")
    .select("id,name,domain,email,country")
    .eq("store_id", storeId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`CRM read: ${error.message}`);
  if (!company) return null;
  const c = company as Record<string, unknown>;
  const { data: contacts } = await db
    .from("crm_contacts")
    .select("email")
    .eq("store_id", storeId)
    .eq("company_id", id)
    .limit(200);
  return {
    name: String(c.name ?? ""),
    domain: (c.domain as string | null) ?? null,
    email: (c.email as string | null) ?? null,
    country: (c.country as string | null) ?? null,
    contacts: ((contacts ?? []) as Array<Record<string, unknown>>).map((r) => ({
      email: (r.email as string | null) ?? null,
    })),
  };
}

async function guard(id: string) {
  const NOT_FOUND = Response.json({ error: "Empresa no encontrada." }, { status: 404 });
  const db = getSupabase();
  const { data } = await db.from("crm_companies").select("store_id").eq("id", id).maybeSingle();
  if (!data) return { error: NOT_FOUND };
  const storeId = String((data as Record<string, unknown>).store_id ?? "");
  // Anti-oráculo (misma forma que GET hermana): sin membresía o sin sesión
  // se responde 404 idéntico, nunca 403/401 (no distingue existe/no-acceso).
  const access = await requireStoreAccess(storeId);
  if (access instanceof Response) return { error: NOT_FOUND };
  return { auth: access, storeId };
}

/** GET /api/companies/:id/research — candidatos + perfiles guardados (sin LLM). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g) return g.error;
  try {
    const ctx = await loadCompanyContext(g.storeId, id);
    if (!ctx) return Response.json({ error: "Empresa no encontrada." }, { status: 404 });
    const { candidates, profiles, discoveredFromWeb } = await describeCompanyCandidates(ctx);
    return Response.json({ candidates, profiles, discoveredFromWeb });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}

/**
 * POST /api/companies/:id/research — investiga dominios (homepage → LLM → `domains`).
 * Body: { domains?: string[]; force?: boolean } (máx 3, default = candidatos).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g) return g.error;
  const { checkRateLimit } = await import("@/lib/rate-limit");
  if (!checkRateLimit(`research:company:${g.storeId}`, 12, 60_000)) {
    return Response.json({ error: "Demasiadas investigaciones. Espera un momento." }, { status: 429 });
  }
  let body: { domains?: unknown; force?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  try {
    const ctx = await loadCompanyContext(g.storeId, id);
    if (!ctx) return Response.json({ error: "Empresa no encontrada." }, { status: 404 });
    const { candidates } = await describeCompanyCandidates(ctx);
    const requested = Array.isArray(body.domains)
      ? (body.domains as unknown[]).map((d) => normalizeDomain(d)).filter(Boolean).slice(0, 3)
      : candidates.map((c) => c.domain);
    const targets = [...new Set(requested)].slice(0, 3);
    if (targets.length === 0) {
      return Response.json({
        error: "Sin dominios para investigar: carga el dominio de la empresa o emails de contactos corporativos.",
        candidates,
      }, { status: 400 });
    }
    const force = body.force === true;
    const results: Array<{ domain: string; status: string; profile?: unknown; error?: string }> = [];
    const seen = new Set(targets);
    for (const d of targets) {
      const r = await researchDomain(d, { storeId: g.storeId, force });
      results.push({ domain: d, ...r });
      // Dominio muerto (no resuelve / bloquea bots): colegir por búsqueda web
      // con el nombre de la empresa antes de rendirse.
      if (r.status === "no-homepage") {
        const found = await discoverDomainFromWeb(ctx.name, ctx.country).catch(() => null);
        if (found && !seen.has(found)) {
          seen.add(found);
          candidates.push({ domain: found, source: "web", count: 1 });
          const fr = await researchDomain(found, { storeId: g.storeId, force });
          results.push({ domain: found, ...fr, fallbackFor: d } as typeof results[number]);
        }
      }
    }
    const profiles = [...(await getDomainProfiles([...seen])).values()];
    return Response.json({ results, profiles, candidates });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Research failed." }, { status: 500 });
  }
}
