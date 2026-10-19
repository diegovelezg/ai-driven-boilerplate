import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { getActiveStore } from "@/lib/tenant";
import { applyScopeFilter, resolveMarketScope } from "@/lib/markets";
import { countDuplicateEmails } from "@/lib/duplicates";
import { pendingDomains } from "@/lib/enrich";

/**
 * GET /api/health?store=<uuid>&market=<uuid>
 * Números vivos de "Salud de tu cartera" para el componente reactivo:
 * duplicados, dominios pendientes (fresco, sin caché de 5min) y compradores.
 * Respeta ?store= y ?market= como el home.
 */
export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }
  const url = new URL(req.url);
  const sp = url.searchParams;
  let active: Awaited<ReturnType<typeof getActiveStore>>["active"] = null;
  try {
    const resolved = await getActiveStore(sp.get("store"));
    active = resolved.active;
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "DB read failed" },
      { status: 500 },
    );
  }
  if (!active) {
    return Response.json({ store_id: null, duplicateCount: 0, enrichPending: 0, buyers: 0 });
  }
  const { requireStoreAccess } = await import("@/lib/api/guard");
  const access = await requireStoreAccess(active.id);
  if (access instanceof Response) return access;
  const db = getSupabase();
  const scope = await resolveMarketScope(active.id, sp.get("market")).catch(() => null);
  try {
    const [dupN, enrichN, buyersN] = await Promise.all([
      countDuplicateEmails(active.id, scope).catch(() => 0),
      pendingDomains(active.id, scope, { fresh: true }).then((d) => d.length).catch(() => 0),
      (async () => {
        const { count: n } = await applyScopeFilter(
          db.from("customers").select("id", { count: "exact", head: true }).eq("store_id", active.id).gt("orders_count", 0),
          scope,
        );
        return n ?? 0;
      })().catch(() => 0),
    ]);
    return Response.json({
      store_id: active.id,
      duplicateCount: dupN,
      enrichPending: enrichN,
      buyers: buyersN,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "DB read failed" },
      { status: 500 },
    );
  }
}
