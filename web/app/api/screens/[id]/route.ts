import { getScreenDetail } from "@/lib/screens-db";
import { requireRouteEntity, resolveMyRole } from "@/lib/api/guard";
import { apiLog } from "@/lib/log";

/**
 * GET /api/screens/:id — ficha para el drawer (Ficha + Comercial + Geo).
 * Misma forma que /api/companies/:id; el drawer la consume por fetch.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const loaded = await requireRouteEntity("inv_screens", id, "store_id", "Pantalla no encontrada.");
    if (loaded instanceof Response) return loaded;
    const { storeId, auth } = loaded;
    const detail = await getScreenDetail(storeId, id);
    if (!detail) return Response.json({ error: "Pantalla no encontrada." }, { status: 404 });
    // Rol del caller para gating de acciones (editar pauta, eliminar).
    const myRole = await resolveMyRole(auth, storeId);
    return Response.json({ store_id: storeId, ...detail, myRole });
  } catch (e) {
    apiLog("screens-id", "screens-id fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
