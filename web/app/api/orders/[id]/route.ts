import { getOrderDetail } from "@/lib/orders-db";
import { getSupabase } from "@/lib/supabase";
import { requireRouteEntity, resolveMyRole } from "@/lib/api/guard";

/** GET /api/orders/:id — detalle para el drawer (ficha + líneas + documentos).
 *  Liviano a propósito (perf 2026-11-09): agencias + contactos viven en
 *  `/api/orders/:id/meta` y solo se piden al editar la ficha. Incluye
 *  `shop_country` (tasa IGV/IVA del tenant, SSOT `lib/tax-rate.ts`). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const loaded = await requireRouteEntity("io_orders", id, "store_id", "Orden no encontrada.");
    if (loaded instanceof Response) return loaded;
    const { storeId, auth } = loaded;
    const detail = await getOrderDetail(storeId, id);
    if (!detail) return Response.json({ error: "Orden no encontrada." }, { status: 404 });
    const myRole = await resolveMyRole(auth, storeId);
    let shopCountry: string | null = null;
    try {
      const db = getSupabase();
      const { data: store } = await db.from("sys_stores").select("shop_country").eq("id", storeId).maybeSingle();
      shopCountry = (store as Record<string, unknown> | null)?.shop_country as string | null ?? null;
    } catch {
      shopCountry = null;
    }
    return Response.json({
      ...detail,
      shop_country: shopCountry,
      myRole,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
