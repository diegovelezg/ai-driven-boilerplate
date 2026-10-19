// Corrida manual del motor de retención (como scout-once.ts).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/retention-once.ts
import { getSupabase } from "@/lib/supabase";
import { runRetentionModel } from "@/lib/retention";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();
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
  fail("RETENTION", e);
});
