import { InMemorySessionService } from "@google/adk";
import { getSupabase } from "@/lib/supabase";
import { requireApiUser, requireStoreMember, resolveRouteCustomerId } from "@/lib/api/guard";
import { CUSTOMER_AGENT_NAME, getCustomerAgent } from "@/lib/adk/agents/customer-agent";
import { createAdkRunner } from "@/lib/adk/runner";
import { displayMarket, resolveMarketScope } from "@/lib/markets";
import { createLogger } from "@/lib/log";

const log = createLogger("adk");

const APP_NAME = "retain_engine";
const SESSION_USER_ID = "merchant";

// Chat del drawer de producto: mismo agente generalista con foco en el ítem.
// Sin memoria persistida (conversations es por customer): el cliente manda
// el historial como contexto en cada turno.
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

  const db = getSupabase();
  const { data: p } = await db
    .from("products")
    .select("id,store_id,title,platform_status,is_active")
    .eq("id", id)
    .maybeSingle();
  if (!p) return Response.json({ error: "Producto no encontrado." }, { status: 404 });
  const pr = p as Record<string, unknown>;
  const storeId = String(pr.store_id ?? "");
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  const denied = await requireStoreMember(storeId, auth);
  if (denied) return denied;

  // Mismo filtro global que el drawer: mismo universo que la GUI muestra.
  // Sin fallback silencioso a "todos": marketId inválido o DB caída = 400.
  let marketScope: Awaited<ReturnType<typeof resolveMarketScope>> | null = null;
  if (typeof body.marketId === "string" && body.marketId) {
    try {
      marketScope = await resolveMarketScope(storeId, body.marketId);
    } catch (e) {
      return Response.json({ error: `Market inválido: ${e instanceof Error ? e.message : "no resolvible"}.`, code: "INVALID_MARKET" }, { status: 400 });
    }
    if (!marketScope?.market) {
      return Response.json({ error: "Market inválido: no existe en esta tienda.", code: "INVALID_MARKET" }, { status: 400 });
    }
  }
  const marketSuffix = marketScope?.market ? ` · mercado ${displayMarket(marketScope.market)}` : "";
  const title = String(pr.title ?? "");
  // Solo identidad en el prompt: las cifras salen de get_product_summary
  // (regla "usa SIEMPRE las tools"; el texto fijo se desactualiza y miente).
  const focusCtx = `Producto en foco: "${title}" (${(pr.platform_status as string | null) ?? "sin estado"}, ${pr.is_active ? "activo" : "inactivo"})${marketSuffix}. Responde sobre ESTE producto (get_product_summary/movements/buyers); para comparar con el resto del catálogo usa get_top_products.`;

  const clientPrior = history
    .slice(0, -1)
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Merchant" : "Agente"}: ${m.content.slice(0, 1500)}`)
    .join("\n");
  const prompt = `${focusCtx}\n\n${clientPrior ? `Historial reciente (contexto; el mensaje actual es lo vigente):\n${clientPrior}\n\n` : ""}Mensaje actual: ${last.content.slice(0, 4000)}`;

  let agent;
  try {
    agent = getCustomerAgent({
      storeId,
      productId: id,
      view: "product_drawer",
      focusLabel: `producto "${title}"${marketSuffix}`,
      marketCountries: marketScope?.countries ?? null,
      marketCustomerIds: marketScope?.customerIds ?? null,
      marketCurrency: marketScope?.market ? marketScope.market.currency.toUpperCase() : null,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "No se pudo iniciar el agente." },
      { status: 503 },
    );
  }

  const runner = createAdkRunner({ agent, appName: APP_NAME, sessionService });
  const sessionId = `prod-${id}`;
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
            const p = part as { text?: string; functionCall?: { name?: string } };
            // Tool en curso → "pensando" descriptivo (los tokens apagan el estado).
            if (p.functionCall?.name) {
              send(statusSse(p.functionCall.name));
              continue;
            }
            if (p.text) send(sse(p.text));
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Falló el agente.";
        log(`product chat falló (${msg})`);
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
