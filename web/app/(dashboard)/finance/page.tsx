import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { AutoRefresh } from "@/components/auto-refresh";
import { SectionHeading } from "@/components/section-heading";
import { bucketMonthly, computeFinanceKpis } from "@/lib/finance";
import { formatMoney, formatNumber } from "@/lib/format";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { displayStoreName, getMyActiveStore, getMyStoreIds, type TenantStore } from "@/lib/tenant";
import { connection } from "next/server";
import { FinanceStrip } from "../finance-strip";
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableRow,
  DataTableTd,
  DataTableTh,
} from "@/components/data-table";

export const instant = false;

// Finanzas DOOH: contratado desde io_lines (rate_minor por
// starts_at) y cobro desde invoices (amount_minor por issue_date/status).
// El motor ecommerce anterior (orders/customers/proposed_actions/
// customer_predictions) se extirpó en la migración
// 20261122000000_drop_retention_engine, así que esta vista ya no lo consulta.
export default async function FinanzasPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string }>;
}) {
  await connection();
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
        <PageHeader
          eyebrow="Dinero y cobro"
          title="Finanzas"
          description="Contratado, facturado y cobrado (DOOH)."
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
    const resolved = await getMyActiveStore(sp.store);
    stores = resolved.stores;
    active = resolved.active;
  } catch (e) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
        <PageHeader
          eyebrow="Dinero y cobro"
          title="Finanzas"
          description="Contratado, facturado y cobrado (DOOH)."
        />
        <AppCardState>
            Stores read: {e instanceof Error ? e.message : "DB read failed"}
        </AppCardState>
      </div>
    );
  }
  if (stores.length === 0 || !active) {
    const myIds = await getMyStoreIds().catch(() => null);
    const noAccess = Array.isArray(myIds) && myIds.length === 0;
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
        <PageHeader
          eyebrow="Dinero y cobro"
          title="Finanzas"
          description="Contratado, facturado y cobrado (DOOH)."
        />
        <AppCard
          footer={
            noAccess ? undefined : (
              <Button render={<Link href="/settings" />} nativeButton={false} variant="outline" size="sm">
                Ir a Settings
              </Button>
            )
          }
        >
          <p className="text-[13px] text-muted-foreground">
            {noAccess
              ? "Tu usuario no tiene tiendas asignadas. Pide a tu admin que te agregue en sys_memberships."
              : "Conecta tu tienda para ver tus finanzas."}
          </p>
        </AppCard>
      </div>
    );
  }

  const db = getSupabase();
  const viewCurrency = active.shop_currency;

  let buckets: ReturnType<typeof bucketMonthly> = [];
  let kpis: ReturnType<typeof computeFinanceKpis> | null = null;
  let invoicedMinor = 0;
  let paidMinor = 0;
  let pendingMinor = 0;
  let overdueMinor = 0;
  let overdueCount = 0;
  let topBrands: Array<{ brand: string; gross: number; ios: number }> = [];
  let topAdvertisers: Array<{ name: string; gross: number; ios: number }> = [];
  let topScreens: Array<{ name: string; gross: number; lines: number }> = [];
  let bottomScreens: Array<{ name: string; gross: number; lines: number }> = [];
  let error: string | null = null;

  try {
    // IOs de la tienda (tope operativo: 500, igual que /orders).
    const { data: ioData, error: ioErr } = await db
      .from("io_orders")
      .select("id,io_number,brand,status,starts_at,advertiser_company_id,billing_company_id")
      .eq("store_id", active.id)
      .order("starts_at", { ascending: false })
      .limit(500);
    if (ioErr) throw new Error(`ios: ${ioErr.message}`);
    const ios = (ioData ?? []) as Array<Record<string, unknown>>;
    const ioIds = ios.map((r) => String(r.id));
    const brandByIo = new Map(ios.map((r) => [String(r.id), String(r.brand ?? "").trim() || "Sin marca"]));
    const advIdByIo = new Map(ios.map((r) => [String(r.id), r.advertiser_company_id ? String(r.advertiser_company_id) : null]));

    // Líneas: contratado. Paginado simple (una tienda DOOH rara vez pasa 5k).
    const lineRows: Array<Record<string, unknown>> = [];
    if (ioIds.length > 0) {
      for (let off = 0; ; off += 1000) {
        const { data: lpage, error: lErr } = await db
          .from("io_lines")
          .select("io_id,screen_id,rate_minor,starts_at")
          .eq("store_id", active.id)
          .in("io_id", ioIds)
          .range(off, off + 999);
        if (lErr) throw new Error(`lineas: ${lErr.message}`);
        const rows = (lpage ?? []) as Array<Record<string, unknown>>;
        lineRows.push(...rows);
        if (rows.length < 1000) break;
        if (lineRows.length >= 20000) break;
      }
    }

    // Facturas de la tienda.
    const invRows: Array<Record<string, unknown>> = [];
    for (let off = 0; ; off += 1000) {
      const { data: ipage, error: iErr } = await db
        .from("io_invoices")
        .select("io_id,amount_minor,currency,status,issue_date,due_date")
        .eq("store_id", active.id)
        .range(off, off + 999);
      if (iErr) throw new Error(`facturas: ${iErr.message}`);
      const rows = (ipage ?? []) as Array<Record<string, unknown>>;
      invRows.push(...rows);
      if (rows.length < 1000) break;
      if (invRows.length >= 20000) break;
    }

    // Contratado → reutiliza bucketMonthly/computeFinanceKpis (puros, sin DB):
    // cada línea es una "orden" con placed_at = starts_at.
    const finOrders = lineRows.map((r) => ({
      total_amount: Number(r.rate_minor ?? 0),
      currency: viewCurrency,
      placed_at: (r.starts_at as string | null) ?? null,
    }));
    buckets = bucketMonthly(finOrders, viewCurrency);
    kpis = computeFinanceKpis(finOrders, viewCurrency);

    // Cobro global desde invoices (misma moneda de la vista).
    const today00 = (() => {
      const n = new Date();
      return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
    })();
    for (const v of invRows) {
      const cur = (v.currency as string | null) ?? null;
      if (viewCurrency && cur && cur.toUpperCase() !== viewCurrency.toUpperCase()) continue;
      const amount = Math.max(0, Math.round(Number(v.amount_minor ?? 0) || 0));
      const st = String(v.status ?? "");
      if (st === "cancelled" || st === "draft" || amount <= 0) continue;
      if (st === "paid") {
        invoicedMinor += amount;
        paidMinor += amount;
        continue;
      }
      if (st === "overdue") {
        invoicedMinor += amount;
        overdueMinor += amount;
        overdueCount += 1;
        continue;
      }
      if (st === "issued") {
        invoicedMinor += amount;
        const dueRaw = (v.due_date as string | null) ?? null;
        const m = dueRaw ? /^(\d{4})-(\d{2})-(\d{2})/.exec(dueRaw) : null;
        if (m) {
          const due = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
          if (Number.isFinite(due) && due < today00) {
            overdueMinor += amount;
            overdueCount += 1;
          }
        }
      }
    }
    pendingMinor = Math.max(0, invoicedMinor - paidMinor);

    // Tops por contratado.
    const grossByBrand = new Map<string, { gross: number; ios: Set<string> }>();
    const grossByAdv = new Map<string, { gross: number; ios: Set<string> }>();
    for (const l of lineRows) {
      const ioId = String(l.io_id ?? "");
      const amt = Number(l.rate_minor ?? 0) || 0;
      const brand = brandByIo.get(ioId) ?? "Sin marca";
      const b = grossByBrand.get(brand) ?? { gross: 0, ios: new Set<string>() };
      b.gross += amt;
      b.ios.add(ioId);
      grossByBrand.set(brand, b);
      const advId = advIdByIo.get(ioId);
      if (advId) {
        const a = grossByAdv.get(advId) ?? { gross: 0, ios: new Set<string>() };
        a.gross += amt;
        a.ios.add(ioId);
        grossByAdv.set(advId, a);
      }
    }
    topBrands = [...grossByBrand.entries()]
      .map(([brand, v]) => ({ brand, gross: v.gross, ios: v.ios.size }))
      .sort((a, b) => b.gross - a.gross)
      .slice(0, 10);

    // Ranking por pantalla: más y menos contratado.
    const grossByScreen = new Map<string, { gross: number; lines: number }>();
    for (const l of lineRows) {
      const sid = String(l.screen_id ?? "");
      if (!sid) continue;
      const amt = Number(l.rate_minor ?? 0) || 0;
      const s = grossByScreen.get(sid) ?? { gross: 0, lines: 0 };
      s.gross += amt;
      s.lines += 1;
      grossByScreen.set(sid, s);
    }
    if (grossByScreen.size > 0) {
      const { data: scData } = await db
        .from("inv_screens")
        .select("id,name,external_ref")
        .eq("store_id", active.id)
        .in("id", [...grossByScreen.keys()]);
      const screenNameBy = new Map(
        ((scData ?? []) as Array<Record<string, unknown>>).map((s) => {
          const ref = String(s.external_ref ?? "").trim();
          const label = String(s.name ?? "").trim() || ref || "Sin nombre";
          return [String(s.id), ref ? `${label} (${ref})` : label];
        }),
      );
      const ranked = [...grossByScreen.entries()]
        .map(([id, v]) => ({ name: screenNameBy.get(id) ?? "Sin nombre", gross: v.gross, lines: v.lines }))
        .sort((a, b) => b.gross - a.gross);
      topScreens = ranked.slice(0, 5);
      bottomScreens = ranked.slice(-5).reverse();
    }

    if (grossByAdv.size > 0) {
      const { data: coData } = await db
        .from("crm_companies")
        .select("id,name")
        .eq("store_id", active.id)
        .in("id", [...grossByAdv.keys()]);
      const nameBy = new Map(
        ((coData ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), String(c.name ?? "")]),
      );
      topAdvertisers = [...grossByAdv.entries()]
        .map(([id, v]) => ({ name: nameBy.get(id) || "Sin nombre", gross: v.gross, ios: v.ios.size }))
        .sort((a, b) => b.gross - a.gross)
        .slice(0, 10);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "DB read failed";
  }

  const closed = buckets.slice(0, -1);
  const bestKey = closed.length > 0 ? closed.reduce((a, b) => (b.salesMinor > a.salesMinor ? b : a)).key : null;
  const worstKey = closed.length > 0 ? closed.reduce((a, b) => (b.salesMinor < a.salesMinor ? b : a)).key : null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
      <AutoRefresh ms={60_000} />
      <PageHeader
        eyebrow="Dinero y cobro"
        title={`Finanzas · ${displayStoreName(active)}`}
        description="Contratado por líneas de IO y cobro por facturas. Montos en la moneda de la tienda."
      />

      {error && (
        <AppCardState>{error}</AppCardState>
      )}

      {kpis && (
        <FinanceStrip
          buckets={buckets}
          kpis={kpis}
          currency={viewCurrency}
        />
      )}

      {kpis && (
        <section aria-label="Cobro">
          <SectionHeading
            title="Cobro"
            hint="Facturado vs cobrado según invoices (sin facturar = contratado aún no facturado)."
            tone="emerald"
          />
          <AppCard>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">Facturado</span>
                <span className="text-xl font-semibold tabular-nums tracking-tight">
                  {formatMoney(invoicedMinor, viewCurrency)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">Cobrado</span>
                <span className="text-xl font-semibold tabular-nums tracking-tight">
                  {formatMoney(paidMinor, viewCurrency)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">Pendiente</span>
                <span className="text-xl font-semibold tabular-nums tracking-tight">
                  {formatMoney(pendingMinor, viewCurrency)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">Vencido</span>
                <span className="text-xl font-semibold tabular-nums tracking-tight">
                  {formatMoney(overdueMinor, viewCurrency)}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatNumber(overdueCount)} {overdueCount === 1 ? "factura" : "facturas"}
                </span>
              </div>
            </div>
          </AppCard>
        </section>
      )}

      {(topScreens.length > 0 || bottomScreens.length > 0) && (
        <section aria-label="Qué más y qué menos vende">
          <SectionHeading
            title="Qué más y qué menos vende"
            hint="Por pantalla, suma de rate_minor de sus líneas."
            tone="violet"
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <AppCard title="Más contratado" variant="table">
              <DataTable>
                <DataTableHeader>
                  <DataTableTh>Pantalla</DataTableTh>
                  <DataTableTh numeric>Líneas</DataTableTh>
                  <DataTableTh numeric>Contratado</DataTableTh>
                </DataTableHeader>
                <DataTableBody className="tabular-nums">
                  {topScreens.map((r) => (
                    <DataTableRow key={r.name}>
                      <DataTableTd>{r.name}</DataTableTd>
                      <DataTableTd numeric>{formatNumber(r.lines)}</DataTableTd>
                      <DataTableTd numeric>{formatMoney(r.gross, viewCurrency)}</DataTableTd>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </AppCard>
            <AppCard title="Menos contratado" variant="table">
              <DataTable>
                <DataTableHeader>
                  <DataTableTh>Pantalla</DataTableTh>
                  <DataTableTh numeric>Líneas</DataTableTh>
                  <DataTableTh numeric>Contratado</DataTableTh>
                </DataTableHeader>
                <DataTableBody className="tabular-nums">
                  {bottomScreens.map((r) => (
                    <DataTableRow key={r.name}>
                      <DataTableTd>{r.name}</DataTableTd>
                      <DataTableTd numeric>{formatNumber(r.lines)}</DataTableTd>
                      <DataTableTd numeric>{formatMoney(r.gross, viewCurrency)}</DataTableTd>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </AppCard>
          </div>
        </section>
      )}

      {buckets.length > 0 && (
        <section aria-label="Detalle mensual">
          <SectionHeading
            title="Contratado mensual"
            hint="Mejor/peor sobre meses cerrados: el mes en curso es parcial y no compite."
            tone="sky"
          />
          <AppCard variant="table">
            <DataTable>
              <DataTableHeader>
                <DataTableTh>Mes</DataTableTh>
                <DataTableTh numeric>Contratado</DataTableTh>
                <DataTableTh numeric>Líneas</DataTableTh>
                <DataTableTh numeric>Ticket</DataTableTh>
              </DataTableHeader>
              <DataTableBody className="tabular-nums">
                {[...buckets].reverse().map((b, i) => (
                  <DataTableRow key={b.key}>
                    <DataTableTd className="capitalize">
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
                    </DataTableTd>
                    <DataTableTd numeric>{formatMoney(b.salesMinor, viewCurrency)}</DataTableTd>
                    <DataTableTd numeric>{formatNumber(b.orders)}</DataTableTd>
                    <DataTableTd numeric>
                      {b.orders > 0
                        ? formatMoney(Math.round(b.salesMinor / b.orders), viewCurrency)
                        : "—"}
                    </DataTableTd>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </AppCard>
        </section>
      )}

      {topBrands.length > 0 && (
        <section aria-label="Top marcas">
          <SectionHeading
            title="Top marcas por contratado"
            hint="Suma de rate_minor de líneas por marca de la IO."
            tone="violet"
          />
          <AppCard variant="table">
            <DataTable>
              <DataTableHeader>
                <DataTableTh>Marca</DataTableTh>
                <DataTableTh numeric>IOs</DataTableTh>
                <DataTableTh numeric>Contratado</DataTableTh>
              </DataTableHeader>
              <DataTableBody className="tabular-nums">
                {topBrands.map((r) => (
                  <DataTableRow key={r.brand}>
                    <DataTableTd>{r.brand}</DataTableTd>
                    <DataTableTd numeric>{formatNumber(r.ios)}</DataTableTd>
                    <DataTableTd numeric>{formatMoney(r.gross, viewCurrency)}</DataTableTd>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </AppCard>
        </section>
      )}

      {topAdvertisers.length > 0 && (
        <section aria-label="Top anunciantes">
          <SectionHeading
            title="Top anunciantes por contratado"
            hint="Por empresa anunciante de la IO."
            tone="emerald"
          />
          <AppCard variant="table">
            <DataTable>
              <DataTableHeader>
                <DataTableTh>Anunciante</DataTableTh>
                <DataTableTh numeric>IOs</DataTableTh>
                <DataTableTh numeric>Contratado</DataTableTh>
              </DataTableHeader>
              <DataTableBody className="tabular-nums">
                {topAdvertisers.map((r) => (
                  <DataTableRow key={r.name}>
                    <DataTableTd>{r.name}</DataTableTd>
                    <DataTableTd numeric>{formatNumber(r.ios)}</DataTableTd>
                    <DataTableTd numeric>{formatMoney(r.gross, viewCurrency)}</DataTableTd>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </AppCard>
        </section>
      )}
    </div>
  );
}
