import { InMemorySessionService } from "@google/adk";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { CUSTOMER_AGENT_NAME, getCustomerAgent } from "@/lib/adk/agents/customer-agent";
import { createAdkRunner } from "@/lib/adk/runner";
import { createLogger } from "@/lib/log";
import { applyScopeFilter, displayMarket, resolveMarketScope } from "@/lib/markets";

const log = createLogger("adk");

const APP_NAME = "retain_engine";
const SESSION_USER_ID = "merchant";

// Sesión in-memory por tienda: el ADK conserva el histórico entre turnos
// mientras el server vive. Sin persistencia DB todavía: `conversations`
// exige customer_id (una fila por ficha) y el chat de tienda no tiene
// customer — el cliente envía `messages[]` como memoria (mismo fallback
// que la ruta de ficha) hasta que exista conversación por tienda.
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

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }

  let body: { storeId?: string; messages?: IncomingMessage[]; marketId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "JSON inválido." }, { status: 400 });
  }

  const storeId = typeof body.storeId === "string" ? body.storeId : "";
  if (!storeId) return Response.json({ error: "Falta storeId." }, { status: 400 });

  // Auth + tenant: solo miembros de la tienda pueden chatear sobre ella.
  const { requireStoreAccess } = await import("@/lib/api/guard");
  const access = await requireStoreAccess(storeId);
  if (access instanceof Response) return access;

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

  // Filtro global por mercado: mismo Scope que el drawer (países/IDs + moneda).
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

  const prior = history
    .slice(0, -1)
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Merchant" : "Agente"}: ${m.content.slice(0, 1500)}`)
    .join("\n");
  const userText = last.content.slice(0, 4000);
  const prompt =
    `Hablas de ${storeName}${marketSuffix} como equipo orquestado (Scout, Estratega, Redactor, Prospector, Mensajero, Analista, Perfilador). ` +
    (prior
      ? `Historial reciente (contexto; el mensaje actual es lo vigente):\n${prior}\n\nMensaje actual: ${userText}`
      : `Mensaje actual: ${userText}`);

  let agent;
  try {
    agent = getCustomerAgent({
      storeId,
      view: "store_chat",
      focusLabel: `${storeName}${marketSuffix} · equipo orquestado`,
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
  const sessionId = `store-${storeId}`;
  await sessionService
    .createSession({ appName: APP_NAME, userId: SESSION_USER_ID, sessionId })
    .catch(() => undefined); // ya existe → ok

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (t: string) => controller.enqueue(encoder.encode(t));
      try {
        // Args de la última llamada por tool en este turno: el canvas los usa
        // como estado inicial de sus filtros (lo pedido en el chat queda
        // seleccionado). Vive fuera del loop porque call y response llegan
        // en eventos distintos.
        const callArgs: Record<string, unknown> = {};
        let wroteActions = false;
        for await (const event of runner.runAsync({
          userId: SESSION_USER_ID,
          sessionId,
          newMessage: { role: "user", parts: [{ text: prompt }] },
        })) {
          if (event.author !== CUSTOMER_AGENT_NAME) continue;
          for (const part of event.content?.parts ?? []) {
            const p = part as {
              text?: string;
              functionCall?: { name?: string; args?: unknown };
              functionResponse?: { name?: string; response?: unknown };
            };
            // Texto del modelo → burbuja del chat.
            if (event.content?.role === "model" && p.text) {
              send(sse(p.text));
              continue;
            }
            if (p.functionCall?.name) {
              // El cliente lo pinta como "pensando" descriptivo.
              send(statusSse(p.functionCall.name));
              if (ARTIFACT_TOOLS.includes(p.functionCall.name)) {
                callArgs[p.functionCall.name as string] = p.functionCall.args ?? null;
              }
              continue;
            }
            // Resultado de tool de datos (role "user", autor = agente) →
            // artefacto que filtra la vista derecha. Arrays llegan como {results: [...]}.
            const fr = p.functionResponse;
            if (fr && ARTIFACT_TOOLS.includes(fr.name ?? "")) {
              const r = fr.response as { results?: unknown; result?: unknown; items?: unknown } | unknown[];
              const data = Array.isArray(r)
                ? r
                : (r as { results?: unknown; result?: unknown; items?: unknown })?.results
                  ?? (r as { result?: unknown })?.result
                  ?? (r as { items?: unknown })?.items
                  ?? r;
              const query = callArgs[fr.name as string] ?? null;
              const n = Array.isArray(data) ? data.length : 1;
              log(`artifact ${fr.name} filas=${n} query=${JSON.stringify(query)}`);
              send(artifactSse(fr.name as string, data, query));
            }
            if (fr && (fr.name === "approve_actions" || fr.name === "reject_actions")) {
              wroteActions = true;
            }
          }
        }
        // Tras una escritura, el canvas quedaría con filas viejas: re-emite
        // los pendientes con los últimos args de list_actions (incluido offset).
        if (wroteActions) {
          try {
            const q = (callArgs["list_actions"] ?? {}) as {
              status?: string;
              limit?: number;
              offset?: number;
              channel?: string;
            };
            const n = q.limit ?? 10;
            const off = q.offset ?? 0;
            let aq = getSupabase()
              .from("proposed_actions")
              .select("id,customer_id,channel,subject,body,status,created_at,customers(email,first_name,last_name)")
              .eq("store_id", storeId)
              .eq("status", q.status ?? "pending_review");
            if (q.channel) aq = aq.eq("channel", q.channel);
            const scope = marketScope
              ? { countries: marketScope.countries, customerIds: marketScope.customerIds }
              : null;
            const { data } = await applyScopeFilter(aq, scope).order("created_at", {
              ascending: false,
            }).range(off, off + n - 1);
            log(`artifact list_actions refresh filas=${(data ?? []).length}`);
            send(artifactSse("list_actions", data ?? [], { status: q.status ?? "pending_review", limit: n, offset: off, channel: q.channel ?? null }));
          } catch (e) {
            log(`refresh tras escritura falló (${e instanceof Error ? e.message : "?"})`);
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
