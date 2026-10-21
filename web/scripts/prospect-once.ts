// Ejecución manual del prospector (como enrich-once.ts).
// Uso: npx tsx --env-file=.env.local scripts/prospect-once.ts [queries] [perQuery] [marketId]
// Sin marketId usa el mercado primario (igual que la mañana). Requiere:
// SearXNG en SEARXNG_URL + ICP en store_profiles + tenant B2B.
import { runProspect } from "@/lib/prospect";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();
  const marketId = process.argv[4] ?? null;

  const { listStoreMarkets, pickPrimaryMarket, resolveMarketScope, displayMarket } = await import("@/lib/markets");
  const { getSupabase } = await import("@/lib/supabase");
  let scope: { countries: string[] | null; customerIds: string[] | null } | null = null;
  let marketLabel: string | null = null;
  try {
    let shopCur: string | null = null;
    try {
      const { data } = await getSupabase().from("stores").select("shop_currency").eq("id", storeId).maybeSingle();
      shopCur = ((data as Record<string, unknown> | null)?.shop_currency as string | null) ?? null;
    } catch {
      shopCur = null;
    }
    const markets = await listStoreMarkets(storeId).catch(() => []);
    const primary = marketId ? markets.find((m) => m.id === marketId) ?? null : pickPrimaryMarket(markets, shopCur);
    if (primary) {
      const resolved = await resolveMarketScope(storeId, primary.id).catch(() => null);
      if (resolved) {
        scope = { countries: resolved.countries, customerIds: resolved.customerIds };
        marketLabel = displayMarket(resolved.market ?? primary);
      }
    }
  } catch {
    scope = null;
  }
  console.log(`scope=${JSON.stringify(scope)} market=${marketLabel}`);

  const runId = await startRun(storeId, "prospect", "Prospección", 1);
  console.log(`run ${runId}`);
  await runProspect(runId, storeId, {
    queries: Number(process.argv[2] ?? 3),
    perQuery: Number(process.argv[3] ?? 5),
    scope,
    marketLabel,
  });
  console.log("fin");
}

main().catch((e) => {
  fail("PROSPECT", e);
});
