import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { SectionHeading } from "@/components/section-heading";
import { getPredEnJuegoByMonth, toEditableCustomer, type EditableCustomer } from "@/lib/customers-db";
import { bucketMonthly, computeFinanceKpis, computeRetentionKpis, last12MonthKeys, monthEndMs, rankCustomers, rankItems, rescateMonthly, type AttributedRevenue, type ItemRanking } from "@/lib/finance";
import { applyScopeFilter, displayMarket, resolveMarketScope } from "@/lib/markets";
import { formatMoney } from "@/lib/medusa";
import { formatNumber } from "@/lib/format";
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
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
        <PageHeader
          eyebrow="Dinero y retención"
          title="Finanzas"
          description="Ventas, recupero y salud del negocio."
        />
        <AppCardState>
            Supabase no configurado (`supabase start` + `web/.env.local`).
        </AppCardState>
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
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
        <PageHeader
          eyebrow="Dinero y retención"
          title="Finanzas"
          description="Ventas, recupero y salud del negocio."
        />
        <AppCardState>
            Stores read: {e instanceof Error ? e.message : "DB read failed"}
        </AppCardState>
      </div>
    );
  }
  if (stores.length === 0 || !active) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
        <PageHeader
          eyebrow="Dinero y retención"
          title="Finanzas"
          description="Ventas, recupero y salud del negocio."
        />
        <AppCard
          footer={
            <Button render={<Link href="/settings" />} nativeButton={false} variant="outline" size="sm">
              Ir a Settings
            </Button>
          }
        >
          <p className="text-[13px] text-muted-foreground">
            Conecta tu tienda para ver tus finanzas.
          </p>
        </AppCard>
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
  // Timestamp fijo por request (igual que el Overview).
  const yearAgoIso = new Date(Date.now() - 400 * 86_400_000).toISOString();

  let buckets: ReturnType<typeof bucketMonthly> = [];
  let kpis: ReturnType<typeof computeFinanceKpis> | null = null;
  let items: ItemRanking = { top: [], bottom: [] };
  let topCustomers: Array<{ customer: EditableCustomer; revenueMinor: number; orders: number }> = [];
  let recoveredMinor = 0;
  let error: string | null = null;
  // Bloque probabilístico (issue #14 B4): /finanzas mostraba el strip
  // clásico porque no le pasaba props. Se replica la foto del día.
  let rescate: ReturnType<typeof rescateMonthly> | undefined;
  let retention: ReturnType<typeof computeRetentionKpis> | null = null;
  let cycleDays: number | null = null;
  let enJuegoProb: { minor: number; low: number; high: number; count: number } | null = null;
  let organicosEnAuto: number | null = null;
  let dataPartial = false;
  try {
    let ordersTruncated = false;
    let revTruncated = false;
    const revRows: Array<Record<string, unknown>> = [];
    for (let off = 0; ; off += 1000) {
      const { data: rpage, error: rErr } = await applyScopeFilter(
        db
          .from("proposed_actions")
          .select("revenue_attributed,dispatched_at,created_at")
          .eq("store_id", active.id)
          .not("revenue_attributed", "is", null),
        scope,
      ).range(off, off + 999);
      if (rErr) throw new Error(`revenue: ${rErr.message}`);
      const rows = (rpage ?? []) as Array<Record<string, unknown>>;
      revRows.push(...rows);
      if (rows.length < 1000) break;
      if (revRows.length >= 20000) {
        revTruncated = true;
        break;
      }
    }
    const orows: Array<Record<string, unknown>> = [];
    for (let off = 0; ; off += 1000) {
      let oq = db
        .from("orders")
        .select("total_amount,currency,placed_at,items_json,customer_id")
        .eq("store_id", active.id)
        .gte("placed_at", yearAgoIso)
        .order("placed_at", { ascending: false });
      if (scope.market) oq = oq.or(`market_id.eq.${scope.market.id},country.is.null`);
      const { data: opage, error: qErr } = await oq.range(off, off + 999);
      if (qErr) throw new Error(`orders: ${qErr.message}`);
      const rows = (opage ?? []) as Array<Record<string, unknown>>;
      orows.push(...rows);
      if (rows.length < 1000) break;
      if (orows.length >= 20000) {
        ordersTruncated = true;
        break;
      }
    }
    if (ordersTruncated || revTruncated) {
      const { createLogger } = await import("@/lib/log");
      createLogger("finanzas")(`store ${active.id} CAP 20k (orders_trunc=${ordersTruncated} rev_trunc=${revTruncated}): KPIs parciales`);
      dataPartial = true;
    }
    const data = orows;
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
      (revRows ?? []) as Array<Record<string, unknown>>
    ).map((r) => ({
      amount: Number(r.revenue_attributed ?? 0),
      at: ((r.dispatched_at as string | null) ?? (r.created_at as string | null) ?? null),
    }));
    recoveredMinor = attributed.reduce((a, r) => a + r.amount, 0);
    const { resolveTenantCycleDays } = await import("@/lib/store-profiles");
    cycleDays = await resolveTenantCycleDays(active.id).catch(() => null);
    if (cycleDays !== null) {
      const predSnap = await getPredEnJuegoByMonth(
        active.id,
        last12MonthKeys(Date.now()).map((k) => ({ key: k.key, endMs: monthEndMs(k.key) })),
        viewCurrency,
      ).catch(() => new Map<string, { minor: number; count: number }>());
      rescate = rescateMonthly(finOrders, attributed, cycleDays, viewCurrency, Date.now(), predSnap);
      retention = computeRetentionKpis(finOrders, attributed, cycleDays, viewCurrency);
    }
    // Foto del día para En juego (esperado): actuar+vigilar intra-moneda.
    try {
      const dayStart = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
      ).toISOString();
      const { data: predDay } = await db
        .from("customer_predictions")
        .select("decision,valor_esperado_minor,p_low,p_high,ticket_esperado_minor,currency")
        .eq("store_id", active.id)
        .gte("as_of", dayStart)
        .limit(5000);
      let rows = (predDay ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        const { data: last } = await db
          .from("customer_predictions")
          .select("decision,valor_esperado_minor,p_low,p_high,ticket_esperado_minor,currency,as_of")
          .eq("store_id", active.id)
          .order("as_of", { ascending: false })
          .limit(5000);
        const all = (last ?? []) as Array<Record<string, unknown>>;
        const maxAsOf = all.length > 0 ? String(all[0].as_of ?? "") : null;
        rows = maxAsOf ? all.filter((r) => String(r.as_of ?? "") === maxAsOf) : [];
      }
      let minor = 0;
      let low = 0;
      let high = 0;
      let count = 0;
      let organicos = 0;
      for (const r of rows) {
        const d = String(r.decision ?? "");
        if (d === "organico") organicos += 1;
        if (d !== "actuar" && d !== "revision_humana" && d !== "vigilar") continue;
        const cur = (r.currency as string | null) ?? null;
        if (viewCurrency && cur && cur.toUpperCase() !== viewCurrency.toUpperCase()) continue;
        const v = r.valor_esperado_minor == null ? null : Number(r.valor_esperado_minor);
        if (v === null) continue;
        minor += v;
        count += 1;
        const tk = r.ticket_esperado_minor == null ? null : Number(r.ticket_esperado_minor);
        if (tk !== null) {
          low += Number(r.p_low ?? 0) * tk;
          high += Number(r.p_high ?? 0) * tk;
        }
      }
      if (count > 0) enJuegoProb = { minor: Math.round(minor), low: Math.round(low), high: Math.round(high), count };
      organicosEnAuto = organicos;
    } catch {
      // Sin predicciones: el strip cae al clásico, no se rompe.
    }
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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="Dinero y retención"
        title={`Finanzas · ${displayStoreName(active)}`}
        description={`Ventas, órdenes y ticket por mes${marketLabel ? ` · viendo ${marketLabel}` : ` en ${(viewCurrency ?? "PEN").toUpperCase()}`}. Otras monedas van aparte.${dataPartial ? ` · muestra parcial (CAP ${formatNumber(20000)})` : ""}`}
      />

      {error && (
        <AppCardState>{error}</AppCardState>
      )}

      {kpis && (
        <FinanceStrip
          buckets={buckets}
          kpis={kpis}
          currency={viewCurrency}
          recoveredMinor={recoveredMinor}
          marketLabel={marketLabel}
          rescate={rescate}
          cycleDays={cycleDays}
          retention={retention ?? undefined}
          enJuegoProb={enJuegoProb}
          organicosEnAuto={organicosEnAuto}
        />
      )}

      {buckets.length > 0 && (
        <section aria-label="Detalle mensual">
          <SectionHeading
            title="Detalle mensual"
            hint="Mejor/peor sobre meses cerrados: el mes en curso es parcial y no compite."
            tone="sky"
          />
          <AppCard variant="table">
            <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b text-left text-[11px] tracking-wide text-muted-foreground uppercase">
                    <th className="px-4 py-3 font-medium">Mes</th>
                    <th className="px-4 py-3 text-right font-medium">Ventas</th>
                    <th className="px-4 py-3 text-right font-medium">Órdenes</th>
                    <th className="px-4 py-3 text-right font-medium">Ticket</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {[...buckets].reverse().map((b, i) => (
                    <tr key={b.key} className="border-b transition-colors last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3 capitalize">
                        {`${b.label} ${b.key.slice(0, 4)}`}
                        {i === 0 && (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            en curso
                          </span>
                        )}
                        {b.key === bestKey && (
                          <span className="ml-2 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                            mejor
                          </span>
                        )}
                        {b.key === worstKey && b.key !== bestKey && (
                          <span className="ml-2 rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600 dark:text-rose-400">
                            peor
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">{formatMoney(b.salesMinor, viewCurrency)}</td>
                      <td className="px-4 py-3 text-right">{formatNumber(b.orders)}</td>
                      <td className="px-4 py-3 text-right">
                        {b.orders > 0
                          ? formatMoney(Math.round(b.salesMinor / b.orders), viewCurrency)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
          </AppCard>
        </section>
      )}

      {items.top.length > 0 && (
        <section aria-label="Items que más y menos venden">
          <SectionHeading
            title="Qué más y qué menos vende"
            hint={`Entre lo que sí se vendió (sin feed no se ven los cero). Montos en ${(viewCurrency ?? "PEN").toUpperCase()}.`}
            tone="violet"
          />
          <ItemsRanking top={items.top} bottom={items.bottom} currency={viewCurrency} />
        </section>
      )}
      {items.top.length === 0 && buckets.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Tus órdenes no traen detalle de items (títulos/cantidades), así que no hay ranking por producto todavía.
        </p>
      )}

      <section aria-label="Mejores clientes">
        <SectionHeading
          title="Tus mejores clientes"
          hint={`Por revenue en los últimos 12 meses, en ${(viewCurrency ?? "PEN").toUpperCase()}. Clic para ver la ficha.`}
          tone="emerald"
        />
        <TopCustomers rows={topCustomers} currency={viewCurrency} />
      </section>
    </div>
  );
}
