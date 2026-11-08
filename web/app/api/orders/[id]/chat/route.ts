import { InMemorySessionService } from "@google/adk";
import { getSupabase } from "@/lib/supabase";
import { requireApiUser, requireStoreMember, resolveRouteCustomerId } from "@/lib/api/guard";
import { CUSTOMER_AGENT_NAME, getCustomerAgent } from "@/lib/adk/agents/customer-agent";
import { createAdkRunner } from "@/lib/adk/runner";
import { getOrderDetail } from "@/lib/orders-db";
import { orderStage, ORDER_STAGE_LABELS } from "@/lib/order-stage";
import { billingStatus, BILLING_LABELS } from "@/lib/billing-status";
import { formatMoney } from "@/lib/format";
import { createLogger } from "@/lib/log";

const log = createLogger("adk");

const APP_NAME = "retain_engine";
const SESSION_USER_ID = "merchant";

// Chat del drawer de orden: mismo agente generalista con foco en la OI.
// Sin memoria persistida: el cliente manda el historial como contexto.
// Snapshot operativo + cobro en el prompt (no hay tool de OI: el texto es
// foto del momento; el detalle vivo está en el drawer).
const sessionService = new InMemorySessionService();

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
}

function sse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/** El cliente pinta `tool` como "pensando" descriptivo (mapa en status-labels). */
function statusSse(tool: string): string {
  return `data: ${JSON.stringify({ status: { tool } })}\n\n`;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return Response.json({ error: "Chat en pausa (Fase 2: agente DOOH en construcción)." }, { status: 501 });
}
