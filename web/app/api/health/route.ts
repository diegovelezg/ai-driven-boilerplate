import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { getMyActiveStore } from "@/lib/tenant";

/**
 * GET /api/health?store=<uuid>
 * Fase 2 DOOH: conteos vivos (empresas, contactos, IOs, pantallas).
 */
export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }
  const url = new URL(req.url);
  const sp = url.searchParams;
  let active: Awaited<ReturnType<typeof getMyActiveStore>>["active"] = null;
  try {
    const resolved = await getMyActiveStore(sp.get("store"));
    active = resolved.active;
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "DB read failed" },
      { status: 500 },
    );
  }
  if (!active) {
    return Response.json({ store_id: null, companies: 0, contacts: 0, orders: 0, screens: 0 });
  }
  const { requireStoreAccess } = await import("@/lib/api/guard");
  const access = await requireStoreAccess(active.id);
  if (access instanceof Response) return access;
  const db = getSupabase();
  const countOf = async (table: string): Promise<number> => {
    try {
      const { count } = await db.from(table).select("id", { count: "exact", head: true }).eq("store_id", active.id);
      return count ?? 0;
    } catch {
      return 0;
    }
  };
  try {
    const [comp, cont, ios, scr, schema] = await Promise.all([
      countOf("crm_companies"),
      countOf("crm_contacts"),
      countOf("io_orders"),
      countOf("inv_screens"),
      (async () => {
        const { checkSchema } = await import("@/lib/schema-guard");
        const gaps = await checkSchema(db);
        return { ok: gaps.length === 0, gaps: gaps.map((g) => g.relation) };
      })().catch(() => ({ ok: true, gaps: [] as string[] })),
    ]);
    return Response.json({
      store_id: active.id,
      companies: comp,
      contacts: cont,
      orders: ios,
      screens: scr,
      schemaOk: schema.ok,
      schemaGaps: schema.gaps,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "DB read failed" },
      { status: 500 },
    );
  }
}
