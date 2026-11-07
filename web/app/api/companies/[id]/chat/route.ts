import { InMemorySessionService } from "@google/adk";
import { getSupabase } from "@/lib/supabase";
import { requireApiUser, requireStoreMember, resolveRouteCustomerId } from "@/lib/api/guard";
import { CUSTOMER_AGENT_NAME, getCustomerAgent } from "@/lib/adk/agents/customer-agent";
import { createAdkRunner } from "@/lib/adk/runner";
import { kindLabel } from "@/lib/crm";
import { createLogger } from "@/lib/log";

const log = createLogger("adk");

const APP_NAME = "retain_engine";
const SESSION_USER_ID = "merchant";

// Chat del drawer de empresa: mismo agente generalista con foco en la empresa.
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
  const { data: c } = await db
    .from("companies")
    .select("id,store_id,name,kind,tax_id")
    .eq("id", id)
    .maybeSingle();
  if (!c) return Response.json({ error: "Empresa no encontrada." }, { status: 404 });
  const co = c as Record<string, unknown>;
  const storeId = String(co.store_id ?? "");
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  const denied = await requireStoreMember(storeId, auth);
  if (denied) return denied;

  const name = String(co.name ?? "");
  const kind = (co.kind as string | null) ?? null;
  const taxId = (co.tax_id as string | null) ?? null;
  // Solo identidad en el prompt: los datos salen de get_company_profile
  // (regla "usa SIEMPRE las tools"; el texto fijo se desactualiza y miente).
  const focusCtx = `Empresa en foco: "${name}" (${kindLabel(kind)}${taxId ? `, RUT ${taxId}` : ""}). Responde sobre ESTA empresa (get_company_profile: contactos, pedidos/IOs, campañas); para comparar con el resto usa filter_customers/get_top_products.`;

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
      companyId: id,
      view: "empresa_drawer",
      focusLabel: `empresa "${name}"`,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "No se pudo iniciar el agente." },
      { status: 503 },
    );
  }

  const runner = createAdkRunner({ agent, appName: APP_NAME, sessionService });
  const sessionId = `emp-${id}`;
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
        log(`empresa chat falló (${msg})`);
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
