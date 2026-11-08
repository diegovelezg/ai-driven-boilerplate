import { getSupabase } from "@/lib/supabase";
import { getOrderDetail } from "@/lib/orders-db";
import { requireApiUser, requireStoreMember, userStoreRoles } from "@/lib/api/guard";

/** GET /api/orders/:id — detalle para el drawer (ficha + líneas + documentos). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  try {
    const db = getSupabase();
    const { data } = await db.from("io_orders").select("store_id").eq("id", id).maybeSingle();
    if (!data) return Response.json({ error: "Orden no encontrada." }, { status: 404 });
    const storeId = String((data as Record<string, unknown>).store_id ?? "");
    const denied = await requireStoreMember(storeId, auth);
    if (denied) return denied;
    const detail = await getOrderDetail(storeId, id);
    if (!detail) return Response.json({ error: "Orden no encontrada." }, { status: 404 });
    let myRole: string | null = null;
    if (auth) {
      const { isMemberRole } = await import("@/lib/roles");
      const roles = await userStoreRoles(auth.id).catch(() => new Map<string, string>());
      const raw = roles.get(storeId) ?? null;
      myRole = raw && isMemberRole(raw) ? raw : null;
    }
    return Response.json({ ...detail, myRole });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
