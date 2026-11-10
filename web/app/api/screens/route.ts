import { getMyActiveStore, requireMyStoreAccess } from "@/lib/tenant";
import { isSupabaseConfigured } from "@/lib/supabase";

// GET /api/screens?store= — picker de pantallas activas para editar líneas
// de borradores (id, nombre, precio de referencia). Solo lectura, top 200.
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
    const { listScreens } = await import("@/lib/screens-db");
    const out: Array<{ id: string; name: string; price_pen: number | null }> = [];
    const PAGE = 100;
    for (let page = 1; page <= 2; page += 1) {
      const res = await listScreens(active.id, {
        active: "active",
        sortKey: "name",
        sortDir: "asc",
        page,
        pageSize: PAGE,
      });
      for (const s of res.rows) {
        out.push({ id: s.id, name: s.name, price_pen: s.price_pen ?? null });
      }
      if (res.rows.length < PAGE) break;
    }
    return Response.json(
      { screens: out.slice(0, 200) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    console.error("[screens]", e instanceof Error ? e.message : e);
    return Response.json({ error: "No se pudieron cargar las pantallas." }, { status: 500 });
  }
}
