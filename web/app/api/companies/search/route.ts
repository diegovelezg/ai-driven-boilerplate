import { getMyActiveStore, requireMyStoreAccess } from "@/lib/tenant";
import { isSupabaseConfigured } from "@/lib/supabase";
import { isCompanyKind } from "@/lib/crm";

// GET /api/companies/search?q=&kind=&kinds=a,b&exclude=id1,id2&limit=
// Picker de empresas activas con fuzzy en servidor (mismo RPC que el
// listado). Para `CompanyPicker` en modo servidor: top-N por query,
// sin precargar el maestro. Solo lectura.
export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Base de datos no disponible." }, { status: 500 });
  }
  const url = new URL(req.url);
  const sp = url.searchParams;
  try {
    const { active } = await getMyActiveStore(sp.get("store"));
    if (!active) return Response.json({ error: "Sin tienda." }, { status: 400 });
    if ((await requireMyStoreAccess(active.id).catch(() => false)) === false) {
      return Response.json({ error: "Sin acceso a esta tienda." }, { status: 403 });
    }
    const q = (sp.get("q") ?? "").trim();
    const kindsParam = sp.get("kinds") ?? sp.get("kind") ?? "";
    const kinds = kindsParam
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k !== "");
    if (kindsParam.trim() !== "" && kinds.length > 0) {
      const bad = kinds.filter((k) => !isCompanyKind(k));
      if (bad.length > 0) {
        return Response.json({ error: `Tipo inválido: ${bad.join(", ")} (agencia, anunciante o proveedor).` }, { status: 400 });
      }
    }
    const limit = Math.min(Math.max(Number(sp.get("limit") ?? 20) || 20, 1), 50);
    const exclude = new Set(
      (sp.get("exclude") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    );
    const { listCrmCompanies } = await import("@/lib/crm-db");
    const { rows } = await listCrmCompanies(active.id, {
      q,
      kinds: kinds.length > 0 ? (kinds as Array<"agencia" | "anunciante" | "proveedor">) : undefined,
      sortKey: "name",
      sortDir: "asc",
      page: 1,
      pageSize: limit + exclude.size,
      status: "active",
    });
    const out = rows
      .filter((r) => !exclude.has(r.id))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        tax_id: r.tax_id,
        domain: r.domain,
        city: r.city,
      }));
    return Response.json({ companies: out }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "No se pudieron buscar empresas." }, { status: 500 });
  }
}
