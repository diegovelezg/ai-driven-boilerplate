import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { getMyActiveStore } from "@/lib/tenant";
import { countDuplicateEmails } from "@/lib/duplicates";
import { pendingDomains } from "@/lib/enrich";

/**
 * GET /api/health?store=<uuid>
 * Números vivos de "Salud de tu cartera" para el componente reactivo:
 * duplicados, dominios pendientes (fresco, sin caché de 5min) y compradores.
 * Respeta ?store= como el home.
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
    return Response.json({ store_id: null, duplicateCount: 0, enrichPending: 0, buyers: 0 });
  }
  const { requireStoreAccess } = await import("@/lib/api/guard");
  const access = await requireStoreAccess(active.id);
  if (access instanceof Response) return access;
  const db = getSupabase();
  try {
    const [dupN, enrichN, buyersN, schema] = await Promise.all([
      countDuplicateEmails(active.id).catch(() => 0),
      pendingDomains(active.id, undefined, { fresh: true }).then((d) => d.length).catch(() => 0),
      (async () => {
        const { count: n } = await db.from("customers").select("id", { count: "exact", head: true }).eq("store_id", active.id).gt("orders_count", 0);
        return n ?? 0;
      })().catch(() => 0),
      // Gate visible (best-effort, nunca tumba el health): si la DB va por
      // detrás del código, la UI/cron lo ve aquí sin leer logs.
      (async () => {
        const { checkSchema } = await import("@/lib/schema-guard");
        const gaps = await checkSchema(db);
        return { ok: gaps.length === 0, gaps: gaps.map((g) => g.relation) };
      })().catch(() => ({ ok: true, gaps: [] as string[] })),
    ]);
    return Response.json({
      store_id: active.id,
      duplicateCount: dupN,
      enrichPending: enrichN,
      buyers: buyersN,
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
