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
  const { data: io } = await db
    .from("insertion_orders")
    .select("id,store_id,io_number,brand,status,starts_at,ends_at,payment_terms_days,advertiser_company_id,billing_company_id")
    .eq("id", id)
    .maybeSingle();
  if (!io) return Response.json({ error: "Orden no encontrada." }, { status: 404 });
  const header = io as Record<string, unknown>;
  const storeId = String(header.store_id ?? "");
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  const denied = await requireStoreMember(storeId, auth);
  if (denied) return denied;

  const detail = await getOrderDetail(storeId, id).catch(() => null);
  const lines = detail?.lines ?? [];
  const oms = detail?.agency_orders ?? [];
  const creatives = detail?.creatives ?? [];
  const invoices = detail?.invoices ?? [];
  const gross = lines.reduce((a, l) => a + Number((l as Record<string, unknown>).rate_minor ?? 0), 0);
  const pendingCreative = creatives.some(
    (c) => (c as Record<string, unknown>).qc_status !== "approved" || (c as Record<string, unknown>).legal_status !== "approved",
  );
  const st = orderStage({
    status: (header.status as string | null) ?? null,
    signed: header.status === "signed",
    hasOm: oms.length > 0,
    materialsOk: creatives.length > 0 && !pendingCreative,
    ended: header.ends_at ? Date.parse(String(header.ends_at)) <= Date.now() : false,
    certified: (detail?.photos_count ?? 0) > 0,
  });
  const bill = billingStatus({
    gross_minor: gross,
    invoices: invoices.map((v) => {
      const r = v as Record<string, unknown>;
      return {
        amount_minor: Number(r.amount_minor ?? 0),
        status: String(r.status ?? ""),
        issue_date: (r.issue_date as string | null) ?? null,
        due_date: (r.due_date as string | null) ?? null,
      };
    }),
    starts_at: (header.starts_at as string | null) ?? null,
    payment_terms_days: typeof header.payment_terms_days === "number" ? (header.payment_terms_days as number) : null,
  });

  const ioNumber = String(header.io_number ?? id);
  const etapaLabel = st.stage === "firmada" && header.status !== "signed" ? "Borrador" : ORDER_STAGE_LABELS[st.stage];
  const brand = typeof header.brand === "string" && header.brand ? ` marca ${header.brand}` : "";
  const periodo = header.starts_at && header.ends_at ? ` periodo ${header.starts_at}→${header.ends_at}` : "";
  const companyId =
    (header.billing_company_id as string | null) ?? (header.advertiser_company_id as string | null) ?? null;
  // Snapshot (no tool de OI): cifras del momento para orientar; el drawer manda.
  const focusCtx = `Orden en foco: OI "${ioNumber}"${brand}${periodo}. Snapshot: etapa operativa ${etapaLabel}${oms.length > 0 ? " (autorizada)" : ""}, cobro ${BILLING_LABELS[bill.status]} (facturado ${formatMoney(bill.invoiced_minor, "PEN")}, cobrado ${formatMoney(bill.paid_minor, "PEN")}, pendiente ${formatMoney(bill.pending_minor, "PEN")}${bill.isPrepaid ? ", con prepago" : ""}), ${lines.length} líneas por ${formatMoney(gross, "PEN")}, ${oms.length} OM/OC, ${creatives.length} piezas, ${detail?.photos_count ?? 0} fotos. Responde sobre ESTA orden; para el cliente usa get_company_profile; para el resto de la tienda usa las tools de resumen.`;

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
      companyId,
      view: "order_drawer",
      focusLabel: `orden "${ioNumber}"`,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "No se pudo iniciar el agente." },
      { status: 503 },
    );
  }

  const runner = createAdkRunner({ agent, appName: APP_NAME, sessionService });
  const sessionId = `ord-${id}`;
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
        log(`orden chat falló (${msg})`);
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
