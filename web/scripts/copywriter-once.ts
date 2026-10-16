// Ejecución manual del copywriter (como scout-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/copywriter-once.ts [limit]
// Requiere: OPENAI_API_KEY o DEEPSEEK_API_KEY (proceso proposer_draft).
import { readFileSync } from "node:fs";
import { getSupabase } from "@/lib/supabase";
import { runCopywriter } from "@/lib/copywriter";
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

  const runId = await startRun(storeId, "copywriter", "Copywriter", 0);
  console.log(`run ${runId}`);
  await runCopywriter(runId, storeId, { limit: Number(process.argv[2] ?? 10) });
  console.log("fin (ver .data/copywriter.log)");
}

main().catch((e) => {
  console.error("COPYWRITER FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
