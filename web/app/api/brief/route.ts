import { getMyActiveStore, requireMyStoreAccess } from "@/lib/tenant";
import { isSupabaseConfigured } from "@/lib/supabase";

/** POST /api/brief — corre el muro diario (sys_runs kind='brief').
 *  Throttle: 1x día salvo force (el slot + dedupe evitan duplicados).
 *  Body: { force?: boolean }. */
export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Base de datos no disponible." }, { status: 500 });
  }
  let force = false;
  try {
    force = ((await req.json()) as { force?: unknown }).force === true;
  } catch {
    force = false;
  }
  try {
    const url = new URL(req.url);
    const { active } = await getMyActiveStore(url.searchParams.get("store"));
    if (!active) return Response.json({ error: "Sin tienda." }, { status: 400 });
    if ((await requireMyStoreAccess(active.id).catch(() => false)) === false) {
      return Response.json({ error: "Sin acceso a esta tienda." }, { status: 403 });
    }
    if (!force) {
      const { getLastFinishedAt } = await import("@/lib/background");
      const { startOfDayUTC } = await import("@/lib/dates");
      const last = await getLastFinishedAt(active.id, "brief").catch(() => null);
      const t = last ? Date.parse(last) : NaN;
      if (Number.isFinite(t) && t >= startOfDayUTC(Date.now())) {
        return Response.json({ ok: true, skipped: true, summary: "Muro: ya corrió hoy." });
      }
    }
    const { runBriefJob } = await import("@/lib/insights");
    const r = await runBriefJob(active.id);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
