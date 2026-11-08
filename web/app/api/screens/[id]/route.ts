import { getSupabase } from "@/lib/supabase";
import { getScreenDetail } from "@/lib/screens-db";
import { requireApiUser, requireStoreMember } from "@/lib/api/guard";

/**
 * GET /api/screens/:id — ficha para el drawer (Ficha + Comercial + Geo).
 * Misma forma que /api/companies/:id; el drawer la consume por fetch.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  try {
    const db = getSupabase();
    const { data } = await db.from("inv_screens").select("store_id").eq("id", id).maybeSingle();
    if (!data) return Response.json({ error: "Pantalla no encontrada." }, { status: 404 });
    const storeId = String((data as Record<string, unknown>).store_id ?? "");
    const denied = await requireStoreMember(storeId, auth);
    if (denied) return denied;
    const detail = await getScreenDetail(storeId, id);
    if (!detail) return Response.json({ error: "Pantalla no encontrada." }, { status: 404 });
    return Response.json({ store_id: storeId, ...detail });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
