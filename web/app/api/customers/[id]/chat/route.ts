import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { toEditableCustomer } from "@/lib/customers-db";
import { streamChat, type ChatMessage } from "@/lib/ai/chat";
import { formatMoney } from "@/lib/medusa";

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
}

function money(minor: number, currency: string | null): string {
  return formatMoney(Number(minor ?? 0), currency);
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
  const history = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (history.length === 0 || history[history.length - 1]?.role !== "user") {
    return Response.json({ error: "Se espera al menos un mensaje de usuario." }, { status: 400 });
  }

  const db = getSupabase();
  const { data: row, error } = await db
    .from("customers")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !row) {
    return Response.json({ error: "Customer no encontrado." }, { status: 404 });
  }
  const c = toEditableCustomer(row as unknown as Record<string, unknown>);

  const { data: orders } = await db
    .from("orders")
    .select("total_amount,currency,placed_at,items_json")
    .eq("customer_id", c.dbId)
    .order("placed_at", { ascending: false })
    .limit(15);

  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Sin nombre";
  const orderLines =
    ((orders as Array<Record<string, unknown>> | null) ?? [])
      .map((o) => {
        const items = ((o.items_json as Array<Record<string, unknown>>) ?? [])
          .slice(0, 5)
          .map((i) => `${String(i.title ?? "?")} x${Number(i.quantity ?? 0)}`)
          .join("; ");
        const date = o.placed_at ? String(o.placed_at).slice(0, 10) : "s/f";
        return `- ${date}: ${money(Number(o.total_amount ?? 0), (o.currency as string) ?? null)}${items ? ` (${items})` : ""}`;
      })
      .join("\n") || "(sin orders registradas)";

  const system: ChatMessage = {
    role: "system",
    content: [
      "Eres el asistente de retención de un ecommerce. Respondes en español, breve y accionable.",
      "Si preguntan por riesgo/churn, basa tu respuesta en los datos (recencia, frecuencia, ticket). Si faltan datos, dilo.",
      "No inventes compras, fechas ni datos que no estén en el contexto.",
      "",
      "CUSTOMER:",
      `Nombre: ${name}`,
      `Email: ${c.email}`,
      `Teléfono: ${c.phone ?? "—"}`,
      `Empresa: ${c.companyName ?? "—"}`,
      `Tipo: ${c.customerType}`,
      `Compras: ${c.ordersCount} | Total: ${money(c.totalSpent, c.currency)}`,
      "",
      "ÚLTIMAS COMPRAS (más reciente primero):",
      orderLines,
    ].join("\n"),
  };

  const { response } = await streamChat("customer_chat", [system, ...history]);
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "LLM no disponible");
    const status = response.status === 503 ? 503 : 502;
    return Response.json(
      {
        error:
          status === 503
            ? "Falta API key (DEEPSEEK_API_KEY u OPENAI_API_KEY en web/.env.local)."
            : `LLM falló: ${text.slice(0, 200)}`,
      },
      { status },
    );
  }
  return new Response(response.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
