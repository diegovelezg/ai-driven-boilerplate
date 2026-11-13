import { getMyActiveStore, requireMyStoreAccess } from "@/lib/tenant";
import { isSupabaseConfigured } from "@/lib/supabase";
import { apiLog } from "@/lib/log";

// GET /api/screens?store= — picker de pantallas activas para editar líneas
// de borradores. Misma forma que `ScreenPick` de nueva orden (SSOT:
// id, nombre, detalle, código, precio). Solo lectura, top 200.
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
    const { getSupabase } = await import("@/lib/supabase");
    const db = getSupabase();
    const { data: sc } = await db
      .from("inv_screens")
      .select("id,name,external_ref,technology,width_px,height_px,price_pen,supplier_company_id,inv_venues!screens_venue_id_fkey(name,district,city)")
      .eq("store_id", active.id)
      .eq("is_active", true)
      .order("name", { ascending: true })
      .limit(200);
    const screenRows = ((sc ?? []) as Array<Record<string, unknown>>);
    const supIds = [...new Set(screenRows.map((s) => s.supplier_company_id).filter((v): v is string => !!v))];
    let supBy = new Map<string, string>();
    if (supIds.length > 0) {
      const { data: sups } = await db
        .from("crm_companies")
        .select("id,name")
        .eq("store_id", active.id)
        .in("id", supIds);
      supBy = new Map(((sups ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), String(c.name ?? "")]));
    }
    const out = screenRows.map((s) => {
      const v = s.inv_venues as unknown as { name?: unknown; district?: unknown; city?: unknown } | null;
      const venue = typeof v?.name === "string" ? v.name : "";
      const district = typeof v?.district === "string" ? v.district : "";
      const city = typeof v?.city === "string" ? v.city : "";
      const supplier = typeof s.supplier_company_id === "string" ? (supBy.get(s.supplier_company_id) ?? "") : "";
      const w = Number(s.width_px);
      const h = Number(s.height_px);
      const res = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${w}×${h}` : "";
      const detail = [venue, district, city, supplier, s.technology, res]
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
        .join(" · ");
      return {
        id: String(s.id),
        name: String(s.name ?? ""),
        detail: detail || null,
        code: String(s.external_ref ?? "").trim() || null,
        price_pen: s.price_pen === null || s.price_pen === undefined ? null : Number(s.price_pen),
      };
    });
    return Response.json(
      { screens: out.slice(0, 200) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    apiLog("screens", "screens fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "No se pudieron cargar las pantallas." }, { status: 500 });
  }
}
