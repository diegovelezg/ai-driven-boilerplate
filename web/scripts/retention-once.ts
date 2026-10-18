// Corrida manual del motor de retención (como scout-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/retention-once.ts
import { readFileSync } from "node:fs";
import { getSupabase } from "@/lib/supabase";
import { runRetentionModel } from "@/lib/retention";

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
  const res = await runRetentionModel(storeId, new Date());
  console.log(
    `predicted=${res.predicted} actuar=${res.actuar} vigilar=${res.vigilar} suprimidos=${res.suprimidos}`,
  );
  // Desglose por decisión del día.
  const { data } = await getSupabase()
    .from("customer_predictions")
    .select("decision")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(5000);
  const counts = new Map<string, number>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const d = String(r.decision ?? "?");
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  console.log("por decisión:", JSON.stringify([...counts.entries()]));
}

main().catch((e) => {
  console.error("RETENTION FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
