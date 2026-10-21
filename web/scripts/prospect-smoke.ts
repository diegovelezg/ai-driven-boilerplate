// Smoke comparativo prospección: baseline vs rico (solo lectura, no escribe leads).
// Uso: npx tsx --env-file=.env.local scripts/prospect-smoke.ts
import { getSupabase } from "@/lib/supabase";
import { getIcp } from "@/lib/prospect";
import { getTenantBrain } from "@/lib/brain";
import { buildQueries, searchSearxng } from "@/lib/retrieval";
import { loadStoreId, fail } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();
  console.log(`store ${storeId}`);
  const db = getSupabase();

  const icp = await getIcp(storeId).catch((e) => ({ text: `ICP ERROR: ${(e as Error).message}`, manual: false }));
  console.log(`\n=== ICP (manual=${(icp as { manual: boolean }).manual}) ===\n${(icp as { text: string }).text}\n`);

  const brain = await getTenantBrain(storeId).catch(() => null);
  console.log("=== BRAIN (lo que hoy SE IGNORA en queries) ===");
  console.log(JSON.stringify({
    topProductos: brain?.topProductos?.slice(0, 5),
    topMarcas: brain?.topMarcas,
    topCategorias: brain?.topCategorias,
    vozCliente: brain?.vozCliente,
    ticketP50: brain?.ticketP50, ticketP80: brain?.ticketP80,
    repeat: brain?.patronesRepite?.topRepeatTitles?.slice(0, 5),
    repeatRate: brain?.patronesRepite?.repeatRate,
  }, null, 2));

  const { count } = await db.from("proposed_leads").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("status", "pending_review");
  console.log(`\npending_leads=${count ?? "?"}`);
  const { data: sample } = await db.from("proposed_leads").select("company,url,icp_score,reason").eq("store_id", storeId).order("created_at", { ascending: false }).limit(5);
  console.log("=== ULTIMOS 5 LEADS (calidad actual) ===");
  console.log(JSON.stringify(sample, null, 2));

  const { data: appr } = await db.from("proposed_leads").select("company,url,icp_score").eq("store_id", storeId).eq("status", "approved").limit(5);
  const { data: rej } = await db.from("proposed_leads").select("company,url").eq("store_id", storeId).eq("status", "rejected").limit(5);
  console.log(`approved=${(appr ?? []).length} rejected=${(rej ?? []).length}`);

  // Queries baseline (lo que genera hoy)
  const queries = await buildQueries((icp as { text: string }).text, 2, null, { storeId });
  console.log("\n=== QUERIES BASELINE ===");
  console.log(JSON.stringify(queries, null, 2));
  for (const q of queries) {
    try {
      const hits = await searchSearxng(q, 5);
      console.log(`\n-- ${q} (${hits.length} hits) --`);
      for (const h of hits.slice(0, 5)) console.log(` - ${h.title.slice(0, 80)} | ${h.url}`);
    } catch (e) {
      console.log(`search FAIL ${q}: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => fail("SMOKE", e));
