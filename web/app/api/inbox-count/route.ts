import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { getMyActiveStore } from "@/lib/tenant";
import { applyScopeFilter, resolveMarketScope } from "@/lib/markets";

/**
 * GET /api/inbox-count?store=<uuid>&market=<uuid>
 * Total del Review Inbox con el mismo criterio que /review y el home:
 * borradores pendientes + leads pendientes + señales abiertas/priorizadas,
 * respetando ?store= y ?market=. Sin badge quemado en el sidebar.
 */
export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }
  const url = new URL(req.url);
  const sp = url.searchParams;
  let stores: Awaited<ReturnType<typeof getMyActiveStore>>["stores"] = [];
  let active: Awaited<ReturnType<typeof getMyActiveStore>>["active"] = null;
  try {
    const resolved = await getMyActiveStore(sp.get("store"));
    stores = resolved.stores;
    active = resolved.active;
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "DB read failed" },
      { status: 500 },
    );
  }
  if (stores.length === 0 || !active) {
    return Response.json(
      { store_id: null, actions: 0, leads: 0, signals: 0, total: 0 },
    );
  }
  // Auth + tenant: el conteo del inbox solo lo ven miembros de la tienda activa.
  const { requireStoreAccess } = await import("@/lib/api/guard");
  const access = await requireStoreAccess(active.id);
  if (access instanceof Response) return access;
  const db = getSupabase();
  const scope = await resolveMarketScope(active.id, sp.get("market")).catch(() => null);
  const count = async (
    table: "proposed_actions" | "proposed_leads" | "churn_signals",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apply: (q: any) => any,
    idCol: string | null = "customer_id",
  ): Promise<number> => {
    const q = applyScopeFilter(
      apply(db.from(table).select("id", { count: "exact", head: true }).eq("store_id", active.id)),
      scope,
      idCol,
    );
    const { count: n, error } = await q;
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  try {
    const [actions, leads, signals] = await Promise.all([
      count("proposed_actions", (q) => q.eq("status", "pending_review")),
      count("proposed_leads", (q) => q.eq("status", "pending_review"), null),
      count("churn_signals", (q) => q.in("status", ["open", "prioritized"])),
    ]);
    return Response.json({
      store_id: active.id,
      actions,
      leads,
      signals,
      total: actions + leads + signals,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "DB read failed" },
      { status: 500 },
    );
  }
}
