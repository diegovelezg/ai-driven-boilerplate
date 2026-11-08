import { getBrandDetail } from "@/lib/brand-db";
import { requireApiUser, requireStoreMember, userStoreRoles } from "@/lib/api/guard";
import { resolveActiveStoreId } from "@/lib/tenant";

/**
 * GET /api/brands/:name — ficha para el drawer (Ficha + Pedidos + Empresas).
 * La marca es derivada (io_orders.brand): se agrupa por clave
 * mayúscula, igual que listBrands. Sin store en la URL: usa la tienda activa
 * + membresía (patrón /api/contacts/job-titles).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  try {
    const storeId = await resolveActiveStoreId();
    if (!storeId) return Response.json({ error: "Sin tienda." }, { status: 400 });
    const denied = await requireStoreMember(storeId, auth);
    if (denied) return denied;
    const brand = decodeURIComponent(name ?? "").trim();
    if (!brand) return Response.json({ error: "Falta marca." }, { status: 400 });
    const detail = await getBrandDetail(storeId, brand);
    if (!detail) return Response.json({ error: "Marca no encontrada." }, { status: 404 });
    let myRole: string | null = null;
    if (auth) {
      const { isMemberRole } = await import("@/lib/roles");
      const roles = await userStoreRoles(auth.id).catch(() => new Map<string, string>());
      const raw = roles.get(storeId) ?? null;
      myRole = raw && isMemberRole(raw) ? raw : null;
    }
    return Response.json({ store_id: storeId, ...detail, myRole });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
