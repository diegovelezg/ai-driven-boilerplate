import { getSupabase } from "@/lib/supabase";
import { requireApiUser, requireStoreMember } from "@/lib/api/guard";
import { isISODateShape, utcDayStart } from "@/lib/format";

/**
 * GET /api/usage?store=<uuid>[&from=YYYY-MM-DD] — consumo LLM del tenant.
 * Lo consume `components/usage-pill.tsx`: `{ total_tokens, calls }` del día
 * (`from`) o histórico. Sin ruta el pill fallaba en silencio con 404.
 * Fail-closed: exige sesión + membresía (anon-dev explícito permitido).
 */
export async function GET(req: Request) {
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const storeId = (url.searchParams.get("store") ?? "").trim();
  const from = (url.searchParams.get("from") ?? "").trim();
  if (!storeId) return Response.json({ error: "Falta store." }, { status: 400 });
  if (from && !isISODateShape(from)) {
    return Response.json({ error: "from inválido (YYYY-MM-DD)." }, { status: 400 });
  }
  const denied = await requireStoreMember(storeId, auth);
  if (denied) return denied;
  try {
    const db = getSupabase();
    let query = db.from("ai_llm_usage").select("total_tokens").eq("store_id", storeId);
    if (from) query = query.gte("created_at", utcDayStart(from));
    const { data, error } = await query.limit(10000);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const total = rows.reduce((acc, r) => acc + (Number(r.total_tokens ?? 0) || 0), 0);
    return Response.json({ total_tokens: total, calls: rows.length });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
