import { getBrandDetail } from "@/lib/brand-db";
import { requireActiveStoreAccess, resolveMyRole } from "@/lib/api/guard";
import { apiLog } from "@/lib/log";

/**
 * GET /api/brands/:name — ficha para el drawer (Ficha + Pedidos + Empresas).
 * La marca es derivada (io_orders.brand): se agrupa por clave
 * mayúscula, igual que listBrands. Sin store en la URL: usa la tienda activa
 * + membresía (patrón /api/contacts/job-titles).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const gated = await requireActiveStoreAccess();
  if (gated instanceof Response) return gated;
  const { storeId, auth } = gated;
  try {
    const brand = decodeURIComponent(name ?? "").trim();
    if (!brand) return Response.json({ error: "Falta marca." }, { status: 400 });
    const detail = await getBrandDetail(storeId, brand);
    if (!detail) return Response.json({ error: "Marca no encontrada." }, { status: 404 });
    // Rol del caller para gating de UI.
    const myRole = await resolveMyRole(auth, storeId);
    return Response.json({ store_id: storeId, ...detail, myRole });
  } catch (e) {
    apiLog("brands-id", "brands-id fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
