import { getSupabase } from "@/lib/supabase";
import { requireActiveStoreAccess } from "@/lib/api/guard";
import { apiLog } from "@/lib/log";

/** Distancia en metros (Haversine). */
function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * GET /api/venues/nearby?lat=&lng=&radius_m= — ubicación existente más cercana.
 * La convención ciudad/distrito se hereda del dato propio (ya validado en BD)
 * en vez de inferirla de la jerarquía administrativa de Mapbox, que en Perú
 * es inconsistente (el distrito a veces viene como `place`, a veces como
 * `locality`, y la región no siempre nombra la ciudad).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const radius = Math.min(Math.max(Number(url.searchParams.get("radius_m")) || 1000, 50), 50000);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return Response.json({ error: "lat/lng inválidos." }, { status: 400 });
  }
  try {
    const gated = await requireActiveStoreAccess();
    if (gated instanceof Response) return gated;
    const { storeId } = gated;
    const db = getSupabase();
    const { data, error } = await db
      .from("inv_venues")
      .select("id,name,city,district,latitude,longitude")
      .eq("store_id", storeId)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .limit(2000);
    if (error) throw new Error(`DB read: ${error.message}`);
    let best: Record<string, unknown> | null = null;
    let bestM = Number.POSITIVE_INFINITY;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const vLat = Number(r.latitude);
      const vLng = Number(r.longitude);
      if (!Number.isFinite(vLat) || !Number.isFinite(vLng)) continue;
      const m = distanceM(lat, lng, vLat, vLng);
      if (m < bestM) {
        bestM = m;
        best = r;
      }
    }
    if (!best || bestM > radius) return Response.json({ match: null });
    return Response.json({
      match: {
        id: String(best.id),
        name: String(best.name ?? ""),
        city: typeof best.city === "string" ? best.city : null,
        district: typeof best.district === "string" ? best.district : null,
        distance_m: Math.round(bestM),
      },
    });
  } catch (e) {
    apiLog("venues-nearby", "venues-nearby fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
