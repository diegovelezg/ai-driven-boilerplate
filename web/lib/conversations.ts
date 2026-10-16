// Memoria de conversación entre reinicios (Fase A, deuda issue #2).
// La sesión ADK es in-memory: este módulo guarda cada turno
// (usuario + modelo) y lo recarga como contexto. Sin `server-only`:
// la ruta de chat y los scripts tsx lo importan (igual que background.ts).
import { getSupabase } from "@/lib/supabase";

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** Últimos turnos de la conversación del customer (más antiguos primero). */
export async function loadHistory(customerId: string, limit = 12): Promise<HistoryTurn[]> {
  const db = getSupabase();
  const { data: conv } = await db
    .from("conversations")
    .select("id")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!conv) return [];
  const { data, error } = await db
    .from("messages")
    .select("role,content")
    .eq("conversation_id", (conv as Record<string, unknown>).id)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, limit));
  if (error) throw new Error(`History read: ${error.message}`);
  return (((data ?? []) as Array<Record<string, unknown>>).reverse()).map((m) => ({
    role: m.role === "model" || m.role === "assistant" ? "assistant" : "user",
    content: String(m.content ?? ""),
  }));
}

/** Guarda un turno completo (upsert de conversación + 2 mensajes). Best-effort: lanza si falla. */
export async function saveTurn(
  storeId: string,
  customerId: string,
  view: string | null,
  userText: string,
  modelText: string,
): Promise<void> {
  if (!userText.trim() && !modelText.trim()) return;
  const db = getSupabase();
  const { data: conv, error: cErr } = await db
    .from("conversations")
    .upsert({ store_id: storeId, customer_id: customerId, view }, { onConflict: "store_id,customer_id" })
    .select("id")
    .single();
  if (cErr || !conv) throw new Error(`Conversation upsert: ${cErr?.message}`);
  const cid = String((conv as Record<string, unknown>).id);
  // Inserts secuenciales (usuario primero): cada fila tiene su propio
  // created_at y el orden cronológico queda determinado.
  if (userText.trim()) {
    const { error } = await db
      .from("messages")
      .insert({ conversation_id: cid, role: "user", content: userText.slice(0, 4000) });
    if (error) throw new Error(`Messages insert: ${error.message}`);
  }
  if (modelText.trim()) {
    const { error } = await db
      .from("messages")
      .insert({ conversation_id: cid, role: "model", content: modelText.slice(0, 8000) });
    if (error) throw new Error(`Messages insert: ${error.message}`);
  }
}
