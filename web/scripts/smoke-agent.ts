// Smoke del agente ADK. Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/smoke-agent.ts [customerId]
// (el flag react-server lo exige lib/log.ts vía `server-only`, igual que enrich-once.ts).
import { InMemorySessionService } from "@google/adk";
import { getSupabase } from "@/lib/supabase";
import { CUSTOMER_AGENT_NAME, getCustomerAgent } from "@/lib/adk/agents/customer-agent";
import { createAdkRunner } from "@/lib/adk/runner";

async function main() {
  let id = process.argv[2];
  if (!id) {
    const { data, error } = await getSupabase()
      .from("customers")
      .select("id")
      .gt("orders_count", 0)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    id = (data?.id as string) ?? "";
  }
  if (!id) throw new Error("No hay customers con compras. Pasa un customerId.");
  const { data: row, error: rowErr } = await getSupabase()
    .from("customers")
    .select("store_id")
    .eq("id", id)
    .maybeSingle();
  if (rowErr) throw new Error(rowErr.message);
  console.log("customer:", id);

  const agent = getCustomerAgent({ storeId: (row?.store_id as string) ?? null, customerId: id, view: "smoke" });
  const sessionService = new InMemorySessionService();
  const runner = createAdkRunner({ agent, appName: "retain_engine", sessionService });
  const sessionId = "smoke";
  await sessionService.createSession({ appName: "retain_engine", userId: "smoke", sessionId });

  const prompt =
    process.argv[3] ?? "¿Está en riesgo de irse este customer? ¿Qué compró y cuándo fue lo último?";
  console.log("Q:", prompt, "\n");

  for await (const event of runner.runAsync({
    userId: "smoke",
    sessionId,
    newMessage: { role: "user", parts: [{ text: prompt }] },
  })) {
    if (event.author !== CUSTOMER_AGENT_NAME || event.content?.role !== "model") continue;
    for (const part of event.content.parts ?? []) {
      const p = part as { text?: string; functionCall?: { name?: string; args?: unknown } };
      if (p.text) process.stdout.write(p.text);
      if (p.functionCall) console.log(`\n[tool call] ${p.functionCall.name}(${JSON.stringify(p.functionCall.args)})`);
    }
  }
  console.log("\n--- fin ---");
}

main().catch((e) => {
  console.error("SMOKE FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
