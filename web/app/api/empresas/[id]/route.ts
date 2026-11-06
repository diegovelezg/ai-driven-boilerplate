import { getSupabase } from "@/lib/supabase";
import { getCrmCompany } from "@/lib/crm-db";
import { requireApiUser, requireStoreMember, userStoreRoles } from "@/lib/api/guard";

/**
 * GET /api/empresas/:id — ficha para el drawer (Ficha + Contactos + Pedidos).
 * Misma forma que getCrmCompany; el drawer la consume por fetch.
 * La comisión de agencia (companies.agency_commission_pct) solo viaja si el
 * rol alcanza agency.commission.view (owner/admin); el resto no la ve.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  try {
    const db = getSupabase();
    const { data } = await db.from("companies").select("store_id").eq("id", id).maybeSingle();
    if (!data) return Response.json({ error: "Empresa no encontrada." }, { status: 404 });
    const storeId = String((data as Record<string, unknown>).store_id ?? "");
    const denied = await requireStoreMember(storeId, auth);
    if (denied) return denied;
    const detail = await getCrmCompany(storeId, id);
    if (!detail) return Response.json({ error: "Empresa no encontrada." }, { status: 404 });
    // Rol del caller para gating de comisión (null = sin auth/dev: ve todo).
    let myRole: string | null = null;
    let canViewCommission = true;
    if (auth) {
      const { isMemberRole, hasMinRole } = await import("@/lib/roles");
      const roles = await userStoreRoles(auth.id).catch(() => new Map<string, string>());
      const raw = roles.get(storeId) ?? null;
      myRole = raw && isMemberRole(raw) ? raw : null;
      canViewCommission =
        myRole !== null && isMemberRole(myRole) && hasMinRole(myRole, "admin");
    }
    const company = { ...(detail.company as Record<string, unknown>) };
    if (!canViewCommission) delete company.agency_commission_pct;
    return Response.json({ store_id: storeId, ...detail, company, myRole });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
