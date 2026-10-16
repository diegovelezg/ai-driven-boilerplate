import { InMemorySessionService } from "@google/adk";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { CUSTOMER_AGENT_NAME, getCustomerAgent } from "@/lib/adk/agents/customer-agent";
import { createAdkRunner } from "@/lib/adk/runner";
import { createLogger } from "@/lib/log";

const log = createLogger("adk");

const APP_NAME = "retain_engine";
const SESSION_USER_ID = "merchant";

// Sesión in-memory por tienda: el ADK conserva el histórico entre turnos
// mientras el server vive. Sin persistencia DB todavía: `conversations`
// exige customer_id (una fila por ficha) y el chat de tienda no tiene
// customer — el cliente envía `messages[]` como memoria (mismo fallback
// que la ruta de ficha) hasta que exista conversación por tienda.
const sessionService = new InMemorySessionService();

export const AGENT_FOCOS = [
  "general",
  "scout",
  "estratega",
  "redactor",
  "prospector",
  "mensajero",
  "analista",
  "perfilador",
  "vigilancia",
  "propuesta",
  "cierre",
] as const;

export type AgentFoco = (typeof AGENT_FOCOS)[number];

const FOCO_LABEL: Record<AgentFoco, string> = {
  general: "tu tienda",
  scout: "Scout · vigilancia",
  estratega: "Estratega · priorización",
  redactor: "Redactor · propuestas",
  prospector: "Prospector · leads",
  mensajero: "Mensajero · envíos",
  analista: "Analista · medición",
  perfilador: "Perfilador · tu negocio",
  vigilancia: "Vigilancia · Scout + Estratega",
  propuesta: "Propuesta · Redactor + Prospector",
  cierre: "Cierre · Mensajero + Analista",
};

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
}

function sse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }

  let body: { storeId?: string; foco?: string; messages?: IncomingMessage[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "JSON inválido." }, { status: 400 });
  }

  const storeId = typeof body.storeId === "string" ? body.storeId : "";
  if (!storeId) return Response.json({ error: "Falta storeId." }, { status: 400 });
  const foco: AgentFoco = (AGENT_FOCOS as readonly string[]).includes(body.foco ?? "")
    ? (body.foco as AgentFoco)
    : "general";

  const history = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
  );
  const last = history[history.length - 1];
  if (!last || last.role !== "user" || !last.content.trim()) {
    return Response.json({ error: "Se espera al menos un mensaje de usuario." }, { status: 400 });
  }

  const { data: store, error } = await getSupabase()
    .from("stores")
    .select("id,name,shop_url")
    .eq("id", storeId)
    .maybeSingle();
  if (error || !store) {
    return Response.json({ error: "Tienda no encontrada." }, { status: 404 });
  }
  const s = store as Record<string, unknown>;
  const storeName = String(s.name ?? s.shop_url ?? storeId);

  const prior = history
    .slice(0, -1)
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Merchant" : "Agente"}: ${m.content.slice(0, 1500)}`)
    .join("\n");
  const userText = last.content.slice(0, 4000);
  const prompt =
    `Hablas de ${storeName} con foco en ${FOCO_LABEL[foco]}. ` +
    (prior
      ? `Historial reciente (contexto; el mensaje actual es lo vigente):\n${prior}\n\nMensaje actual: ${userText}`
      : `Mensaje actual: ${userText}`);

  let agent;
  try {
    agent = getCustomerAgent({
      storeId,
      view: "store_chat",
      focusLabel: `${storeName} · ${FOCO_LABEL[foco]}`,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "No se pudo iniciar el agente." },
      { status: 503 },
    );
  }

  const runner = createAdkRunner({ agent, appName: APP_NAME, sessionService });
  const sessionId = `store-${storeId}`;
  await sessionService
    .createSession({ appName: APP_NAME, userId: SESSION_USER_ID, sessionId })
    .catch(() => undefined); // ya existe → ok

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (t: string) => controller.enqueue(encoder.encode(t));
      try {
        for await (const event of runner.runAsync({
          userId: SESSION_USER_ID,
          sessionId,
          newMessage: { role: "user", parts: [{ text: prompt }] },
        })) {
          if (event.author !== CUSTOMER_AGENT_NAME || event.content?.role !== "model") continue;
          for (const part of event.content.parts ?? []) {
            const text = (part as { text?: string }).text;
            if (text) send(sse(text));
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Falló el agente.";
        log(`store chat falló (${msg})`);
        send(sse(`\n\n⚠️ ${msg}`));
      } finally {
        send("data: [DONE]\n\n");
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
