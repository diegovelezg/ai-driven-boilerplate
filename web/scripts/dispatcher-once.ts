// Ejecución manual del dispatcher (como scout-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/dispatcher-once.ts
// Sin RETAIN_DISPATCH_STUB=1 no envía nada (bloqueado: sin proveedor).
import { readFileSync } from "node:fs";
import { getSupabase } from "@/lib/supabase";
import { runDispatcher } from "@/lib/dispatcher";
import { startRun } from "@/lib/background";

async function resolveStoreId(medusaUrl: string): Promise<string | null> {
  const normalized = medusaUrl.trim().replace(/\/+$/, "").toLowerCase();
  const { data } = await getSupabase()
    .from("stores")
    .select("id")
    .eq("platform", "medusa")
    .eq("shop_url", normalized)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

async function main() {
  const conn = JSON.parse(readFileSync(".data/connections.json", "utf-8"));
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) throw new Error("Tienda sin sincronizar en Supabase.");

  const runId = await startRun(storeId, "dispatcher", "Dispatcher", 0);
  console.log(`run ${runId}`);
  await runDispatcher(runId, storeId);
  console.log("fin (ver .data/dispatcher.log)");
}

main().catch((e) => {
  console.error("DISPATCHER FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
