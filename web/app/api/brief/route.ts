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
    const { checkRateLimit } = await import("@/lib/rate-limit");
    // Clave por tienda+usuario: un usuario no agota la cuota de toda la tienda.
    let rateKey = `brief:${active.id}:anon`;
    try {
      const { createServerSupabase } = await import("@/lib/supabase-server");
      const supabase = await createServerSupabase();
      const { data } = await supabase.auth.getUser();
      if (data.user?.id) rateKey = `brief:${active.id}:${data.user.id}`;
    } catch {
      // sin sesión resoluble: cae a :anon (fail-closed en throttle)
    }
    if (!checkRateLimit(rateKey, 5, 60_000)) {
      return Response.json({ error: "Demasiadas corridas. Espera un momento." }, { status: 429 });
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
    console.error("[brief]", e instanceof Error ? e.message : e);
    return Response.json({ error: "No se pudo correr el muro." }, { status: 500 });
  }
}
