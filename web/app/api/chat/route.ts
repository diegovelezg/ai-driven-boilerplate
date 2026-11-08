import { InMemorySessionService } from "@google/adk";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { CUSTOMER_AGENT_NAME, getCustomerAgent } from "@/lib/adk/agents/customer-agent";
import { createAdkRunner } from "@/lib/adk/runner";
import { createLogger } from "@/lib/log";

const log = createLogger("adk");

const APP_NAME = "retain_engine";
const SESSION_USER_ID = "merchant";

// Sesión in-memory por tienda: el ADK conserva el histórico entre turnos
// mientras el server vive. Sin persistencia DB (ai_conversations se dará
// de alta cuando exista conversación por tienda/empresa): el cliente envía
// `messages[]` como memoria hasta entonces.
const sessionService = new InMemorySessionService();

/** Chat único: el orquestador (customer_agent generalista) decide qué
 *  especialista invocar por turno. El user nunca elige agente: es orgánico. */

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
}

function sse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/** Tools cuyos resultados filtran la vista derecha: se reenvían al cliente como
 *  artefacto (list_actions/list_leads → Review filtrado; filter_customers →
 *  tabla de Customers filtrada), no se repiten en el chat.
 *  El resumen (get_store_summary) NO es artefacto: se responde en el chat.
 *  list_signals tampoco: las señales son insumo interno del loop; al merchant
 *  se le responde con decisiones del motor (filter_customers), en el chat. */
const ARTIFACT_TOOLS = ["list_actions", "list_leads", "filter_customers"];

function artifactSse(tool: string, data: unknown, query: unknown): string {
  const rows = Array.isArray(data) ? data.slice(0, 20) : data;
  return `data: ${JSON.stringify({ artifact: { tool, data: rows, query: query ?? null } })}\n\n`;
}

/** El cliente pinta `tool` como "pensando" descriptivo (mapa en status-labels). */
function statusSse(tool: string): string {
  return `data: ${JSON.stringify({ status: { tool } })}\n\n`;
}

export async function POST(_req: Request) {
  return Response.json({ error: "Chat en pausa (Fase 2: agente DOOH en construcción)." }, { status: 501 });
}
