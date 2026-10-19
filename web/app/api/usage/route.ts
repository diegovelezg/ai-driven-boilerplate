import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { listStores, pickRequestedStore } from "@/lib/tenant";

/**
 * GET /api/usage?store=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD&process=
 * Agregado de tokens por tenant desde `llm_usage` (issue #15).
 * Valida ?store= contra stores; filtra por rango opcional y proceso.
 */
export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }
  const url = new URL(req.url);
  const storeParam = url.searchParams.get("store");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const process = url.searchParams.get("process");

  const stores = await listStores().catch((e) => {
    console.log(`[api/usage] listStores fallo: ${e instanceof Error ? e.message : "?"}`);
    return [];
  });
  const store = pickRequestedStore(stores, storeParam);
  if (!store) {
    console.log(`[api/usage] store invalido param=${storeParam} stores=${stores.length}`);
    return Response.json({ error: "Falta store válido." }, { status: 400 });
  }
  // Auth + tenant: el agregado de tokens solo lo ven miembros de la tienda.
  const { requireStoreAccess } = await import("@/lib/api/guard");
  const access = await requireStoreAccess(store.id);
  if (access instanceof Response) return access;

  const db = getSupabase();
  let q = db
    .from("llm_usage")
    .select("process,provider,model,prompt_tokens,completion_tokens,total_tokens,created_at")
    .eq("store_id", store.id)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (from) q = q.gte("created_at", `${from}T00:00:00.000Z`);
  if (to) q = q.lte("created_at", `${to}T23:59:59.999Z`);
  if (process) q = q.eq("process", process);

  const { data, error } = await q;
  if (error) {
    console.log(`[api/usage] query fallo store=${store.id}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;

  let prompt = 0;
  let completion = 0;
  let total = 0;
  const byProcess = new Map<string, { calls: number; prompt: number; completion: number; total: number }>();
  const byModel = new Map<string, { calls: number; prompt: number; completion: number; total: number }>();
  for (const r of rows) {
    const p = Number(r.prompt_tokens ?? 0);
    const c = Number(r.completion_tokens ?? 0);
    const t = Number(r.total_tokens ?? 0);
    prompt += p;
    completion += c;
    total += t;
    const pk = String(r.process ?? "?");
    const mk = `${String(r.provider ?? "?")}/${String(r.model ?? "?")}`;
    const a = byProcess.get(pk) ?? { calls: 0, prompt: 0, completion: 0, total: 0 };
    a.calls += 1;
    a.prompt += p;
    a.completion += c;
    a.total += t;
    byProcess.set(pk, a);
    const b = byModel.get(mk) ?? { calls: 0, prompt: 0, completion: 0, total: 0 };
    b.calls += 1;
    b.prompt += p;
    b.completion += c;
    b.total += t;
    byModel.set(mk, b);
  }

  return Response.json({
    store_id: store.id,
    calls: rows.length,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    by_process: Object.fromEntries(byProcess),
    by_model: Object.fromEntries(byModel),
  });
}
