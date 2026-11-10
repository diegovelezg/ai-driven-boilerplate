import { getCrmCompany } from "@/lib/crm-db";
import { requireRouteEntity, resolveMyRole } from "@/lib/api/guard";

/**
 * GET /api/companies/:id — ficha para el drawer (Ficha + Contactos + Pedidos).
 * Misma forma que getCrmCompany; el drawer la consume por fetch.
 * La comisión de agencia (companies.agency_commission_pct) solo viaja si el
 * rol alcanza agency.commission.view (owner/admin); el resto no la ve.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const loaded = await requireRouteEntity("crm_companies", id, "store_id", "Empresa no encontrada.");
    if (loaded instanceof Response) return loaded;
    const { storeId, auth } = loaded;
    const detail = await getCrmCompany(storeId, id);
    if (!detail) return Response.json({ error: "Empresa no encontrada." }, { status: 404 });
    // Rol del caller para gating de comisión (null = sin auth/dev: ve todo).
    const myRole = await resolveMyRole(auth, storeId);
    let canViewCommission = true;
    if (auth) {
      const { isMemberRole, hasMinRole } = await import("@/lib/roles");
      canViewCommission = myRole !== null && isMemberRole(myRole) && hasMinRole(myRole, "admin");
    }
    const company = { ...(detail.company as Record<string, unknown>) };
    if (!canViewCommission) delete company.agency_commission_pct;
    return Response.json({ store_id: storeId, ...detail, company, myRole });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
