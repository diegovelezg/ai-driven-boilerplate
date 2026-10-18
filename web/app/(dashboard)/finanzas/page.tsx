import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toEditableCustomer, type EditableCustomer } from "@/lib/customers-db";
import { bucketMonthly, computeFinanceKpis, rankCustomers, rankItems, type AttributedRevenue, type ItemRanking } from "@/lib/finance";
import { applyScopeFilter, displayMarket, resolveMarketScope } from "@/lib/markets";
import { formatMoney } from "@/lib/medusa";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { displayStoreName, getActiveStore, type TenantStore } from "@/lib/tenant";
import { FinanceStrip } from "../finance-strip";
import { ItemsRanking } from "./items-ranking";
import { TopCustomers } from "./top-customers";

export const instant = false;

export default async function FinanzasPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; market?: string }>;
}) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Finanzas</h1>
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">
            Supabase no configurado (`supabase start` + `web/.env.local`).
          </CardContent>
        </Card>
      </div>
    );
  }

  const sp = await searchParams;
  let stores: TenantStore[] = [];
  let active: TenantStore | null = null;
  try {
    const resolved = await getActiveStore(sp.store);
    stores = resolved.stores;
    active = resolved.active;
  } catch (e) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Finanzas</h1>
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">
            Stores read: {e instanceof Error ? e.message : "DB read failed"}
          </CardContent>
        </Card>
      </div>
    );
  }
  if (stores.length === 0 || !active) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Finanzas</h1>
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <p className="text-[13px] text-muted-foreground">
              Conecta tu tienda para ver tus finanzas.
            </p>
            <Button render={<Link href="/settings" />} nativeButton={false} variant="outline" size="sm">
              Ir a Settings
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const db = getSupabase();
  const scope = await resolveMarketScope(active.id, sp.market).catch(() => ({
    market: null,
    countries: null,
    customerIds: null,
  }));
  const viewCurrency = scope.market?.currency?.toUpperCase() ?? active.shop_currency;
  // eslint-disable-next-line react-hooks/purity -- timestamp fijo por request (igual que el Overview)
  const yearAgoIso = new Date(Date.now() - 400 * 86_400_000).toISOString();

  let buckets: ReturnType<typeof bucketMonthly> = [];
  let kpis: ReturnType<typeof computeFinanceKpis> | null = null;
  let items: ItemRanking = { top: [], bottom: [] };
  let topCustomers: Array<{ customer: EditableCustomer; revenueMinor: number; orders: number }> = [];
  let recoveredMinor = 0;
  let error: string | null = null;
  try {
    let fq = db
      .from("orders")
      .select("total_amount,currency,placed_at,items_json,customer_id")
      .eq("store_id", active.id)
      .gte("placed_at", yearAgoIso)
      .order("placed_at", { ascending: false });
    if (scope.market) fq = fq.or(`market_id.eq.${scope.market.id},country.is.null`);
    const revQ = applyScopeFilter(
      db
        .from("proposed_actions")
        .select("revenue_attributed,dispatched_at,created_at")
        .eq("store_id", active.id)
        .not("revenue_attributed", "is", null),
      scope,
    ).limit(500);
    const [{ data, error: qErr }, revRows] = await Promise.all([fq.limit(5000), revQ]);
    if (qErr) throw new Error(`orders: ${qErr.message}`);
    if (revRows.error) throw new Error(`revenue: ${revRows.error.message}`);
    const finOrders = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      total_amount: Number(r.total_amount ?? 0),
      currency: (r.currency as string | null) ?? null,
      placed_at: (r.placed_at as string | null) ?? null,
      items_json: r.items_json,
      customer_id: r.customer_id,
    }));
    buckets = bucketMonthly(finOrders, viewCurrency);
    kpis = computeFinanceKpis(finOrders, viewCurrency);
    items = rankItems(finOrders, viewCurrency, 10);
    const attributed: AttributedRevenue[] = (
      (revRows.data ?? []) as Array<Record<string, unknown>>
    ).map((r) => ({
      amount: Number(r.revenue_attributed ?? 0),
      at: ((r.dispatched_at as string | null) ?? (r.created_at as string | null) ?? null),
    }));
    recoveredMinor = attributed.reduce((a, r) => a + r.amount, 0);
    // Fichas del top: una sola query por ~10 ids (nunca miles).
    // toEditableCustomer ya aplica propercase (misma regla que Customers).
    const ranked = rankCustomers(finOrders, viewCurrency, 10);
    if (ranked.length > 0) {
      const { data: custRows, error: custErr } = await db
        .from("customers")
        .select(
          "id,external_id,email,first_name,last_name,phone,company_name,customer_type,country,external_created_at,orders_count,total_spent,currency,stats_by_currency,manual_edits",
        )
        .eq("store_id", active.id)
        .in(
          "id",
          ranked.map((r) => r.customerId),
        );
      if (custErr) throw new Error(`customers: ${custErr.message}`);
      const byId = new Map(
        ((custRows ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), c]),
      );
      topCustomers = ranked.flatMap((r) => {
        const c = byId.get(r.customerId);
        if (!c) return [];
        return [{ customer: toEditableCustomer(c), revenueMinor: r.revenueMinor, orders: r.orders }];
      });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "DB read failed";
  }

  // Mejor/peor sobre meses cerrados: el mes en curso es parcial y no compite.
  const closed = buckets.slice(0, -1);
  const bestKey = closed.length > 0 ? closed.reduce((a, b) => (b.salesMinor > a.salesMinor ? b : a)).key : null;
  const worstKey = closed.length > 0 ? closed.reduce((a, b) => (b.salesMinor < a.salesMinor ? b : a)).key : null;

  const marketLabel = scope.market ? displayMarket(scope.market) : null;

  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex flex-col gap-0.5">
        <h1 className="text-lg font-semibold tracking-tight">
          Finanzas · {displayStoreName(active)}
        </h1>
        <span className="text-xs text-muted-foreground">
          Ventas, órdenes y ticket por mes, en {(viewCurrency ?? "PEN").toUpperCase()}
          {marketLabel ? ` · viendo ${marketLabel}` : ""}. Otras monedas van aparte.
        </span>
      </header>

      {error && (
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">{error}</CardContent>
        </Card>
      )}

      {kpis && (
        <FinanceStrip
          buckets={buckets}
          kpis={kpis}
          currency={viewCurrency}
          recoveredMinor={recoveredMinor}
          marketLabel={marketLabel}
        />
      )}

      {buckets.length > 0 && (
        <section aria-label="Detalle mensual">
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="p-3 font-medium">Mes</th>
                    <th className="p-3 text-right font-medium">Ventas</th>
                    <th className="p-3 text-right font-medium">Órdenes</th>
                    <th className="p-3 text-right font-medium">Ticket</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {[...buckets].reverse().map((b, i) => (
                    <tr key={b.key} className="border-b last:border-0">
                      <td className="p-3 capitalize">
                        {`${b.label} ${b.key.slice(0, 4)}`}
                        {i === 0 && (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            en curso
                          </span>
                        )}
                        {b.key === bestKey && (
                          <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-700">
                            mejor
                          </span>
                        )}
                        {b.key === worstKey && b.key !== bestKey && (
                          <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[11px] text-red-600">
                            peor
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right">{formatMoney(b.salesMinor, viewCurrency)}</td>
                      <td className="p-3 text-right">{b.orders}</td>
                      <td className="p-3 text-right">
                        {b.orders > 0
                          ? formatMoney(Math.round(b.salesMinor / b.orders), viewCurrency)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <p className="mt-2 text-xs text-muted-foreground">
            Mejor/peor sobre meses cerrados (el mes en curso es parcial y no compite).
          </p>
        </section>
      )}

      {items.top.length > 0 && (
        <section aria-label="Items que más y menos venden">
          <ItemsRanking top={items.top} bottom={items.bottom} currency={viewCurrency} />
          <p className="mt-2 text-xs text-muted-foreground">
            Entre lo que sí se vendió: sin feed de productos no se ven los items con cero ventas.
            Montos en {(viewCurrency ?? "PEN").toUpperCase()}.
          </p>
        </section>
      )}
      {items.top.length === 0 && buckets.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Tus órdenes no traen detalle de items (títulos/cantidades), así que no hay ranking por producto todavía.
        </p>
      )}

      <TopCustomers rows={topCustomers} currency={viewCurrency} />
    </div>
  );
}
