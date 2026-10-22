import { InMemorySessionService } from "@google/adk";
import { getSupabase } from "@/lib/supabase";
import { requireCustomerStoreAccess, resolveRouteCustomerId } from "@/lib/api/guard";
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

/** El cliente pinta `tool` como "pensando" descriptivo (mapa en status-labels). */
function statusSse(tool: string): string {
  return `data: ${JSON.stringify({ status: { tool } })}\n\n`;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const idOrErr = await resolveRouteCustomerId(params);
  if (idOrErr instanceof Response) return idOrErr;
  const id = idOrErr;
  const access = await requireCustomerStoreAccess(id);
  if (access instanceof Response) return access;

  let body: { messages?: IncomingMessage[]; marketId?: string };
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
  // Mismo Scope que tienda/producto: sin fallback silencioso (400 si inválido).
  const c = customer as Record<string, unknown>;
  const focusName = [c.first_name, c.last_name].filter(Boolean).join(" ") || String(c.email ?? id);
  const storeIdForScope = String(c.store_id ?? "");
  let marketScope: { countries: string[] | null; customerIds: string[] | null; market?: { currency: string } | null } | null = null;
  if (typeof body.marketId === "string" && body.marketId) {
    try {
      const { resolveMarketScope } = await import("@/lib/markets");
      const resolved = await resolveMarketScope(storeIdForScope, body.marketId);
      if (!resolved?.market) {
        return Response.json({ error: "Market inválido: no existe en esta tienda.", code: "INVALID_MARKET" }, { status: 400 });
      }
      marketScope = resolved;
    } catch (e) {
      return Response.json({ error: `Market inválido: ${e instanceof Error ? e.message : "no resolvible"}.`, code: "INVALID_MARKET" }, { status: 400 });
    }
  }
  const ctx = {
    storeId: (c.store_id as string) ?? null,
    customerId: id,
    view: "customer_drawer",
    focusLabel: `${focusName} <${String(c.email ?? "")}>`,
    marketCountries: marketScope?.countries ?? null,
    marketCustomerIds: marketScope?.customerIds ?? null,
    marketCurrency: marketScope?.market ? String(marketScope.market.currency ?? "").toUpperCase() : null,
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
            const p = part as { text?: string; functionCall?: { name?: string } };
            // Tool en curso → "pensando" descriptivo (los tokens apagan el estado).
            if (p.functionCall?.name) {
              send(statusSse(p.functionCall.name));
              continue;
            }
            if (p.text) {
              modelText += p.text;
              send(sse(p.text));
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
