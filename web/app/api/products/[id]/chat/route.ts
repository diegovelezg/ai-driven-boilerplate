import { InMemorySessionService } from "@google/adk";
import { getSupabase } from "@/lib/supabase";
import { requireApiUser, requireStoreMember, resolveRouteCustomerId } from "@/lib/api/guard";
import { CUSTOMER_AGENT_NAME, getCustomerAgent } from "@/lib/adk/agents/customer-agent";
import { createAdkRunner } from "@/lib/adk/runner";
import { createLogger } from "@/lib/log";
import { formatMoney, formatNumber } from "@/lib/format";

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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const idOrErr = await resolveRouteCustomerId(params);
  if (idOrErr instanceof Response) return idOrErr;
  const id = idOrErr;

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

  const db = getSupabase();
  const { data: p } = await db
    .from("products")
    .select("id,store_id,title,platform_status,is_active,variants_json")
    .eq("id", id)
    .maybeSingle();
  if (!p) return Response.json({ error: "Producto no encontrado." }, { status: 404 });
  const pr = p as Record<string, unknown>;
  const storeId = String(pr.store_id ?? "");
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  const denied = await requireStoreMember(storeId, auth);
  if (denied) return denied;

  const { data: stats } = await db
    .from("product_stats")
    .select("currency,qty_all,revenue_all,qty_30d,buyers_all")
    .eq("store_id", storeId)
    .eq("product_id", id)
    .limit(10);
  const title = String(pr.title ?? "");
  const totals = ((stats ?? []) as Array<Record<string, unknown>>)
    .map((s) => `${formatNumber(Number(s.qty_all ?? 0))} uds · ${formatMoney(Number(s.revenue_all ?? 0), (s.currency as string | null) ?? null)} (30d: ${formatNumber(Number(s.qty_30d ?? 0))}, compradores: ${formatNumber(Number(s.buyers_all ?? 0))})`)
    .join(" | ") || "sin ventas registradas";
  const variants = (Array.isArray(pr.variants_json) ? (pr.variants_json as Array<Record<string, unknown>>) : []).length;
  const focusCtx = `Producto en foco: "${title}" (${(pr.platform_status as string | null) ?? "sin estado"}, ${pr.is_active ? "activo" : "inactivo"}). Ventas: ${totals}. Variantes: ${variants}. Responde sobre ESTE producto; para comparar con el resto del catálogo usa get_top_products.`;

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
      view: "product_drawer",
      focusLabel: `producto "${title}"`,
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
            const text = (part as { text?: string }).text;
            if (text) send(sse(text));
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
