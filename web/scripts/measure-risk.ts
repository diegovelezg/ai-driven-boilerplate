// Medición store-wide con la MISMA lógica del motor (bulk, sin N+1).
// Uso: npx tsx --env-file=.env.local scripts/measure-risk.ts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { medianInterval } from "@/lib/customer-data";
import { ARCHETYPES, getStoreProfile } from "@/lib/store-profiles";
import { isRealOrder } from "@/lib/medusa";

async function main() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const medusaUrl = String(
    JSON.parse(readFileSync(".data/connections.json", "utf-8")).medusaUrl,
  ).replace(/\/+$/, "");
  const { data: store } = await db.from("stores").select("id").eq("shop_url", medusaUrl).maybeSingle();
  if (!store) throw new Error("Sin store para esta conexión.");
  const storeId = store.id as string;
  const profile = await getStoreProfile(storeId);
  const tenantCycle = profile?.repurchaseCycleDays ?? null;
  const archCycle = profile ? ARCHETYPES[profile.archetype].defaultCycleDays : null;
  const mult = profile?.churnMultiplier ?? 1.25;
  console.log(`perfil: archetype=${profile?.archetype} tenantCycle=${tenantCycle} archCycle=${archCycle} mult=${mult}`);

  const { data: customers } = await db
    .from("customers")
    .select("id,orders_count,last_order_at")
    .eq("store_id", storeId);
  const buyers = (customers ?? []).filter((c) => Number(c.orders_count ?? 0) > 0);
  const ids = buyers.map((c) => c.id as string);
  const orders: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db
      .from("orders")
      .select("customer_id,placed_at,status,payment_status,is_test")
      .in("customer_id", ids.slice(i, i + 200))
      .order("placed_at", { ascending: true });
    orders.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  const byCust = new Map<string, Date[]>();
  for (const o of orders) {
    if (!isRealOrder({ status: (o.status as string) ?? null, paymentStatus: (o.payment_status as string) ?? null, isTest: Boolean(o.is_test) })) continue;
    const cid = o.customer_id as string;
    if (!byCust.has(cid)) byCust.set(cid, []);
    if (o.placed_at) byCust.get(cid)!.push(new Date(o.placed_at as string));
  }
  const now = Date.now();
  let vencido = 0, porVencer = 0, alDia = 0, sinCiclo = 0;
  const top: Array<Record<string, number | string>> = [];
  for (const c of buyers) {
    const dates = (byCust.get(c.id as string) ?? []).filter((d) => !Number.isNaN(d.getTime()));
    const med = medianInterval(dates);
    const expected = med ?? tenantCycle ?? archCycle;
    const lastRaw = (c.last_order_at as string) ?? null;
    const last = lastRaw ? new Date(lastRaw) : dates[dates.length - 1];
    const rec = last && !Number.isNaN(last.getTime())
      ? Math.max(0, Math.floor((now - last.getTime()) / 86_400_000))
      : null;
    if (rec === null || expected === null) { sinCiclo++; continue; }
    if (rec > expected * mult) {
      vencido++;
      if (top.length < 10) top.push({ id: (c.id as string).slice(0, 8), f: Number(c.orders_count ?? 0), rec, exp: expected, over: rec - expected });
    } else if (rec > expected) porVencer++;
    else alDia++;
  }
  console.log(`buyers=${buyers.length} vencido=${vencido} por_vencer=${porVencer} al_dia=${alDia} sin_ciclo=${sinCiclo}`);
  console.log("top vencidos (muestra):", JSON.stringify(top));
}

main().catch((e) => {
  console.error("MEASURE FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
