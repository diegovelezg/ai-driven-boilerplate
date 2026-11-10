// Chat DOOH en vivo (ADK): un factory por scope, streaming SSE.
// SSOT: las 6 rutas (chat + companies/contacts/orders/[id] + brands/[name] +
// screens/[id]) comparten este handler; cada route.ts solo fija su scope y el
// runtime nodejs. El cliente (`components/chat/sse.ts`) espera:
//   data: {"choices":[{"delta":{"content":"…"}}]}  → tokens
//   data: {"status":{"tool":"get_screen"}}          → "pensando"
//   data: {"artifact":{"tool":"…","data":…}}        → dato estructurado
// Defensa: auth + membresía por tenant, validación fail-closed del body,
// store del lado servidor (la entidad manda, no el body), sin streaming
// de secrets. Escrituras: ninguna (tools read-only).
import "server-only";
import { getCustomerAgent, type AgentContext } from "@/lib/adk/agents/customer-agent";
import { createAdkRunner } from "@/lib/adk/runner";
import { getChatSessionService } from "@/lib/adk/sessions";
import { buildChatPrompt, parseChatBody, sseEncode, type ChatMessageIn } from "@/lib/api/chat-protocol";

export type ChatScope = "store" | "screen" | "company" | "order" | "contact" | "brand";

/** Tablas por scope (SSOT: una sola rama en vez de ×4 duplicadas). */
const ENTITY_TABLES: Record<
  Exclude<ChatScope, "store" | "brand">,
  { table: string; columns: string; patchKey: "screenId" | "companyId" | "orderId" | "contactId"; labelOf: (row: Record<string, unknown>, fallback: string) => string | null }
> = {
  screen: {
    table: "inv_screens",
    columns: "id,store_id,name",
    patchKey: "screenId",
    labelOf: (row) => (typeof row.name === "string" ? row.name : null),
  },
  company: {
    table: "crm_companies",
    columns: "id,store_id,name",
    patchKey: "companyId",
    labelOf: (row) => (typeof row.name === "string" ? row.name : null),
  },
  order: {
    table: "io_orders",
    columns: "id,store_id,io_number",
    patchKey: "orderId",
    labelOf: (row) => (typeof row.io_number === "string" ? row.io_number : null),
  },
  contact: {
    table: "crm_contacts",
    columns: "id,store_id,first_name,last_name",
    patchKey: "contactId",
    labelOf: (row) => {
      const label = [row.first_name, row.last_name].filter((x) => typeof x === "string" && x).join(" ");
      return label || null;
    },
  },
};

async function resolveEntityStore(
  scope: ChatScope,
  params: unknown,
): Promise<{ storeId: string | null; entityKey: string; focusLabel: string | null; patch: Partial<AgentContext> }> {
  const p = (params ?? {}) as Record<string, unknown>;
  const { getSupabase } = await import("@/lib/supabase");
  const db = getSupabase();
  if (scope === "brand" && typeof p.name === "string") {
    const name = decodeURIComponent(p.name);
    return { storeId: null, entityKey: name, focusLabel: name, patch: { brandName: name } };
  }
  if (scope === "store") {
    return { storeId: null, entityKey: "store", focusLabel: null, patch: {} };
  }
  const conf = ENTITY_TABLES[scope as keyof typeof ENTITY_TABLES];
  if (conf && typeof p.id === "string") {
    const { data } = await db.from(conf.table).select(conf.columns).eq("id", p.id).maybeSingle();
    const row = (data ?? null) as Record<string, unknown> | null;
    if (!row) return { storeId: null, entityKey: p.id, focusLabel: null, patch: { [conf.patchKey]: p.id } as Partial<AgentContext> };
    return {
      storeId: String(row.store_id ?? ""),
      entityKey: String(row.id ?? p.id),
      focusLabel: conf.labelOf(row, p.id),
      patch: { [conf.patchKey]: String(row.id ?? p.id) } as Partial<AgentContext>,
    };
  }
  const key = scope === "brand" ? String((p as Record<string, unknown>).name ?? "store") : "store";
  return { storeId: null, entityKey: key, focusLabel: null, patch: {} };
}

export function createChatRoute(opts?: { scope?: ChatScope }) {
  const scope: ChatScope = opts?.scope ?? "store";
  return async function POST(req: Request, ctx?: { params: Promise<unknown> }) {
    // 1. Auth (401 honesto; anon-dev solo fuera de prod).
    let user: { id: string; email: string | null } | null = null;
    try {
      const { requireApiUser } = await import("@/lib/api/guard");
      const auth = await requireApiUser();
      if (auth instanceof Response) return auth;
      user = auth;
    } catch {
      return Response.json({ error: "No autenticado." }, { status: 401 });
    }

    // 2. Body fail-closed (400).
    let messages: ChatMessageIn[];
    let bodyStoreId: string | null;
    try {
      const body: unknown = await req.json().catch(() => null);
      const parsed = parseChatBody(body);
      messages = parsed.messages;
      bodyStoreId = parsed.storeId;
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "Body inválido." }, { status: 400 });
    }

    // 3. Tenant del lado servidor: la entidad manda; el body solo sugiere.
    let params: unknown = {};
    try {
      if (ctx?.params) params = await ctx.params;
    } catch {
      params = {};
    }
    let storeId: string | null = null;
    let entityKey = "store";
    let entityLabel: string | null = null;
    let patch: Partial<AgentContext> = {};
    try {
      const { isSupabaseConfigured } = await import("@/lib/supabase");
      if (!isSupabaseConfigured()) {
        return Response.json({ error: "Base de datos no disponible." }, { status: 500 });
      }
      if (scope === "store") {
        if (bodyStoreId) {
          storeId = bodyStoreId;
        } else {
          const { resolveActiveStoreId } = await import("@/lib/tenant");
          storeId = await resolveActiveStoreId().catch(() => null);
        }
      } else {
        const ent = await resolveEntityStore(scope, params);
        entityKey = ent.entityKey;
        entityLabel = ent.focusLabel;
        patch = ent.patch;
        if (ent.storeId) {
          if (bodyStoreId && bodyStoreId !== ent.storeId) {
            return Response.json({ error: "La ficha no pertenece a esa tienda." }, { status: 403 });
          }
          storeId = ent.storeId;
        } else if (scope === "brand") {
          // Marca: sin store propio → tienda del body o activa.
          if (bodyStoreId) {
            storeId = bodyStoreId;
          } else {
            const { resolveActiveStoreId } = await import("@/lib/tenant");
            storeId = await resolveActiveStoreId().catch(() => null);
          }
        } else {
          return Response.json({ error: "Ficha no encontrada." }, { status: 404 });
        }
      }
      if (!storeId) return Response.json({ error: "Sin tienda." }, { status: 400 });
      if (user) {
        const { hasStoreMembership } = await import("@/lib/tenant");
        const ok = await hasStoreMembership(user.id, storeId).catch(() => false);
        if (!ok) return Response.json({ error: "Sin acceso a esta tienda." }, { status: 403 });
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "No se pudo resolver la tienda." }, { status: 500 });
    }

    // 4. Agente + sesión (una por usuario×tienda×foco: multi-turn sin body).
    const agentCtx: AgentContext = {
      storeId,
      view: scope === "store" ? "chat" : scope,
      focusLabel: entityLabel,
      ...patch,
    };
    let agent: ReturnType<typeof getCustomerAgent>;
    try {
      agent = getCustomerAgent(agentCtx);
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "Agente no disponible (revisa llm_models.json y API keys)." },
        { status: 500 },
      );
    }
    const sessionService = getChatSessionService();
    const runner = createAdkRunner({ agent, appName: "dooh", sessionService });
    const userId = user?.id ?? "anon-dev";
    // Anon-dev (sin sesión) NUNCA comparte: id efímero por request, sin
    // reuso entre usuarios (antes `dooh-<store>-<scope>-<key>` fijo fugaba
    // contexto entre anónimos). Autenticado: estable por usuario×foco.
    const sessionId = (user
      ? `dooh-${storeId}-${scope}-${entityKey}-${userId}`
      : `dooh-${storeId}-${scope}-${entityKey}-anon-${crypto.randomUUID()}`
    ).slice(0, 120);
    try {
      const existing = await sessionService.getSession({ appName: "dooh", userId, sessionId }).catch(() => undefined);
      if (!existing) {
        await sessionService.createSession({ appName: "dooh", userId, sessionId });
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "No se pudo abrir la sesión." }, { status: 500 });
    }

    // 5. Streaming SSE con el protocolo que `sse.ts` ya parsea.
    const { text } = buildChatPrompt(messages);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: unknown) => controller.enqueue(encoder.encode(sseEncode(payload)));
        try {
          const events = runner.runAsync({
            userId,
            sessionId,
            newMessage: { role: "user", parts: [{ text }] },
            abortSignal: req.signal,
          });
          for await (const raw of events) {
            if (req.signal.aborted) break;
            const event = raw as unknown as {
              errorCode?: string;
              errorMessage?: string;
              content?: { parts?: Array<{ text?: string; functionCall?: { name?: string }; functionResponse?: { name?: string; response?: unknown } }> };
            };
            if (event.errorCode || event.errorMessage) {
              throw new Error(typeof event.errorMessage === "string" ? event.errorMessage : "El modelo falló.");
            }
            const parts = event.content?.parts ?? [];
            for (const part of parts) {
              if (part.functionCall?.name) send({ status: { tool: part.functionCall.name } });
              if (part.functionResponse?.name) {
                send({ artifact: { tool: part.functionResponse.name, data: part.functionResponse.response ?? null, query: null } });
              }
              if (typeof part.text === "string" && part.text) {
                // Rebanado suave: el cliente anexa tokens; un solo chunk gigante
                // también funciona, pero esto pinta progreso real.
                for (let i = 0; i < part.text.length; i += 300) {
                  send({ choices: [{ delta: { content: part.text.slice(i, i + 300) } }] });
                }
              }
            }
          }
        } catch (e) {
          const honest =
            e instanceof Error && /abort/i.test(e.message)
              ? "Se canceló la respuesta."
              : "No pude consultar tus datos ahora. Reintenta en unos segundos.";
          try {
            send({ choices: [{ delta: { content: `\n\n_${honest}_` } }] });
          } catch {
            // controlador ya cerrado: nada que hacer
          }
        } finally {
          try {
            controller.close();
          } catch {
            // doble cierre inofensivo
          }
        }
      },
      cancel() {
        // El abort del cliente llega vía req.signal; nada que limpiar aquí.
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}
