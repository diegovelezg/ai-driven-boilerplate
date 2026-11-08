import { requireApiUser, requireStoreMember } from "@/lib/api/guard";
import { resolveActiveStoreId } from "@/lib/tenant";
import { normalizeDomain } from "@/lib/company-domains";
import {
  describeCompanyCandidates,
  discoverDomainFromWeb,
  getDomainProfiles,
  researchDomain,
} from "@/lib/company-research";

/**
 * Research de marcas (tab Perfil del drawer).
 * La marca no tiene dominio ni contactos propios: el candidato sale de
 * búsqueda web por nombre (colegir), y la ficha se persiste en `domains`.
 */

async function guard() {
  const auth = await requireApiUser();
  if (auth instanceof Response) return { error: auth };
  const storeId = await resolveActiveStoreId();
  if (!storeId) return { error: Response.json({ error: "Sin tienda." }, { status: 400 }) };
  const denied = await requireStoreMember(storeId, auth);
  if (denied) return { error: denied };
  return { auth, storeId };
}

/** GET /api/brands/:name/research — candidatos + perfiles guardados (sin LLM). */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const g = await guard();
  if ("error" in g) return g.error;
  try {
    const brand = decodeURIComponent(name ?? "").trim();
    if (!brand) return Response.json({ error: "Falta marca." }, { status: 400 });
    const { candidates, profiles, discoveredFromWeb } = await describeCompanyCandidates({
      name: brand,
      domain: null,
      email: null,
      country: null,
      contacts: [],
    });
    return Response.json({ brand, candidates, profiles, discoveredFromWeb });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}

/**
 * POST /api/brands/:name/research — investiga dominios (homepage → LLM → `domains`).
 * Body: { domains?: string[]; force?: boolean } (máx 3; default = descubrir por nombre).
 */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const g = await guard();
  if ("error" in g) return g.error;
  let body: { domains?: unknown; force?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  try {
    const brand = decodeURIComponent(name ?? "").trim();
    if (!brand) return Response.json({ error: "Falta marca." }, { status: 400 });
    let requested = Array.isArray(body.domains)
      ? (body.domains as unknown[]).map((d) => normalizeDomain(d)).filter(Boolean).slice(0, 3)
      : [];
    if (requested.length === 0) {
      const found = await discoverDomainFromWeb(brand, null).catch(() => null);
      if (!found) {
        return Response.json({
          error: `Sin web hallada para “${brand}”: la búsqueda no devolvió un dominio investigable.`,
          candidates: [],
        }, { status: 400 });
      }
      requested = [found];
    }
    const targets = [...new Set(requested)].slice(0, 3);
    const force = body.force === true;
    const results: Array<{ domain: string; status: string; profile?: unknown; error?: string }> = [];
    const candidates = [];
    for (const d of targets) {
      const r = await researchDomain(d, { storeId: g.storeId, force });
      results.push({ domain: d, ...r });
      candidates.push({ domain: d, source: "web", count: 1 });
    }
    const profiles = [...(await getDomainProfiles(targets)).values()];
    return Response.json({ brand, results, profiles, candidates });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Research failed." }, { status: 500 });
  }
}
