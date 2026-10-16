import { InMemorySessionService } from "@google/adk";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { CUSTOMER_AGENT_NAME, getCustomerAgent } from "@/lib/adk/agents/customer-agent";
import { createAdkRunner } from "@/lib/adk/runner";
import { loadHistory, saveTurn } from "@/lib/conversations";
import { createLogger } from "@/lib/log";

const log = createLogger("adk");

const APP_NAME = "retain_engine";
const SESSION_USER_ID = "merchant";

// Sesión in-memory por customer: ADK conserva el histórico entre turnos.
const sessionService = new InMemorySessionService();

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
}

function sse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }
  const { id } = await params;
  if (!id) return Response.json({ error: "Falta id." }, { status: 400 });

  let body: { messages?: IncomingMessage[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "JSON inválido." }, { status: 400 });
  }

  const history = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
  );
  const last = history[history.length - 1];
  if (!last || last.role !== "user" || !last.content.trim()) {
    return Response.json({ error: "Se espera al menos un mensaje de usuario." }, { status: 400 });
  }

  // Historial reciente como contexto: primero la memoria persistida
  // (`conversations`/`messages`, sobrevive reinicios/HMR); si está vacía,
  // el `messages[]` que envía el cliente como fallback.
  // El mensaje actual aún no está guardado: no hay duplicados.
  let prior: string | null = null;
  try {
    const dbHist = await loadHistory(id, 10);
    if (dbHist.length > 0) {
      prior = dbHist
        .map((m) => `${m.role === "user" ? "Merchant" : "Agente"}: ${m.content.slice(0, 1000)}`)
        .join("\n");
    }
  } catch (e) {
    log(`historial DB falló (${e instanceof Error ? e.message : e}); fallback a messages[] del cliente`);
  }
  if (prior === null) {
    const clientPrior = history
      .slice(0, -1)
      .slice(-8)
      .map((m) => `${m.role === "user" ? "Merchant" : "Agente"}: ${m.content.slice(0, 1500)}`)
      .join("\n");
    if (clientPrior) prior = clientPrior;
  }
  const prompt = prior
    ? `Historial reciente (contexto; el mensaje actual es lo vigente):\n${prior}\n\nMensaje actual: ${last.content.slice(0, 4000)}`
    : last.content.slice(0, 4000);

  const { data: customer, error } = await getSupabase()
    .from("customers")
    .select("id,store_id,first_name,last_name,email")
    .eq("id", id)
    .maybeSingle();
  if (error || !customer) {
    return Response.json({ error: "Customer no encontrado." }, { status: 404 });
  }

  // Contexto generalista: la tienda enfoca el ámbito; la ficha, el customer.
  const c = customer as Record<string, unknown>;
  const focusName = [c.first_name, c.last_name].filter(Boolean).join(" ") || String(c.email ?? id);
  const ctx = {
    storeId: (c.store_id as string) ?? null,
    customerId: id,
    view: "customer_drawer",
    focusLabel: `${focusName} <${String(c.email ?? "")}>`,
  };

  // Construir el agente aquí cubre errores de config/API key antes de streamear.
  let agent;
  try {
    agent = getCustomerAgent(ctx);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "No se pudo iniciar el agente." },
      { status: 503 },
    );
  }

  const runner = createAdkRunner({ agent, appName: APP_NAME, sessionService });
  const sessionId = `cust-${id}`;
  await sessionService
    .createSession({ appName: APP_NAME, userId: SESSION_USER_ID, sessionId })
    .catch(() => undefined); // ya existe → ok

  const encoder = new TextEncoder();
  const userText = last.content.slice(0, 4000);
  const storeId = (c.store_id as string) ?? "";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (t: string) => controller.enqueue(encoder.encode(t));
      let modelText = "";
      try {
        for await (const event of runner.runAsync({
          userId: SESSION_USER_ID,
          sessionId,
          newMessage: { role: "user", parts: [{ text: prompt }] },
        })) {
          if (event.author !== CUSTOMER_AGENT_NAME || event.content?.role !== "model") continue;
          for (const part of event.content.parts ?? []) {
            const text = (part as { text?: string }).text;
            if (text) {
              modelText += text;
              send(sse(text));
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Falló el agente.";
        send(sse(`\n\n⚠️ ${msg}`));
      } finally {
        // Memoria persistida (best-effort, fuera del stream del cliente).
        try {
          await saveTurn(storeId, id, "customer_drawer", userText, modelText);
        } catch (e) {
          log(`saveTurn falló (${e instanceof Error ? e.message : e})`);
        }
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
