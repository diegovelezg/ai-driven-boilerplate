import Link from "next/link";
import { AlertTriangle, BadgeCheck, FileText, Hourglass, Settings2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { Metric, MetricRow } from "@/components/metric";
import { PageHeader } from "@/components/page-header";
import { AutoRefresh } from "@/components/auto-refresh";
import { SectionHeading } from "@/components/section-heading";
import { bucketMonthly, computeFinanceKpis } from "@/lib/finance";
import { invoiceMatchesOrder, isValidCurrency, normalizeCurrency } from "@/lib/currency";
import { formatMoney, formatNumber } from "@/lib/format";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { displayStoreName, getMyActiveStore, getMyStoreIds, type TenantStore } from "@/lib/tenant";
import { connection } from "next/server";
import { FinanceStrip } from "../finance-strip";
import { CurrencyFilter } from "./currency-filter";
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
  searchParams: Promise<{ store?: string; moneda?: string }>;
}) {
  await connection();
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
        <PageHeader
          eyebrow="Dinero y cobro"
          title="Finanzas"
          description="Qué está contratado, qué se facturó y qué falta cobrar."
        />
        <AppCardState>Base de datos no disponible.</AppCardState>
      </div>
    );
  }

  const sp = await searchParams;
  const monedaParam = (sp.moneda ?? "").trim().toUpperCase();
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
          description="Qué está contratado, qué se facturó y qué falta cobrar."
        />
        <AppCardState>
          {e instanceof Error ? e.message : "No se pudieron cargar los datos."}
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
          description="Qué está contratado, qué se facturó y qué falta cobrar."
        />
        <AppCard
          footer={
            noAccess ? undefined : (
              <Button render={<Link href="/settings" />} nativeButton={false} variant="outline" size="sm">
                <Settings2 aria-hidden />
                Ir a configuración
              </Button>
            )
          }
        >
          <p className="text-[13px] text-muted-foreground">
            {noAccess
              ? "Tu usuario no tiene tiendas asignadas. Pide a un administrador que te dé acceso."
              : "Conecta una tienda para ver tus finanzas."}
          </p>
        </AppCard>
      </div>
    );
  }

  const db = getSupabase();
  const viewCurrency = normalizeCurrency(active.shop_currency, "PEN");

  interface CurrencyFinance {
    currency: string;
    buckets: ReturnType<typeof bucketMonthly>;
    kpis: ReturnType<typeof computeFinanceKpis> | null;
    invoicedMinor: number;
    paidMinor: number;
    pendingMinor: number;
    overdueMinor: number;
    overdueCount: number;
    topBrands: Array<{ brand: string; gross: number; ios: number }>;
    topAdvertisers: Array<{ name: string; gross: number; ios: number }>;
    topScreens: Array<{ name: string; gross: number; lines: number }>;
    bottomScreens: Array<{ name: string; gross: number; lines: number }>;
  }
  let finBy: CurrencyFinance[] = [];
  let activeMoneda: string | null = null;
  let visibleFin: CurrencyFinance[] = [];
  let unassignedInvoices: Array<Record<string, unknown>> = [];
  let unassignedMinor = 0;
  let error: string | null = null;

  try {
    // IOs de la tienda (tope operativo: 500, igual que /orders).
    const { data: ioData, error: ioErr } = await db
      .from("io_orders")
      .select("id,io_number,brand,status,starts_at,advertiser_company_id,billing_company_id,currency")
      .eq("store_id", active.id)
      .order("starts_at", { ascending: false })
      .limit(500);
    if (ioErr) throw new Error(`ios: ${ioErr.message}`);
    const ios = (ioData ?? []) as Array<Record<string, unknown>>;
    const ioIds = ios.map((r) => String(r.id));
    const brandByIo = new Map(ios.map((r) => [String(r.id), String(r.brand ?? "").trim() || "Sin marca"]));
    const advIdByIo = new Map(ios.map((r) => [String(r.id), r.advertiser_company_id ? String(r.advertiser_company_id) : null]));
    const currencyByIo = new Map(
      ios.map((r) => [String(r.id), normalizeCurrency(r.currency, viewCurrency)]),
    );

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

    // Monedas presentes: solo valores explícitos y válidos (nunca sumar
    // mixto y nunca heredar: una factura sin moneda no se asigna a la de su
    // IO en silencio, va a `unassignedInvoices` y se avisa en la UI.
    const curSet = new Set<string>();
    for (const c of currencyByIo.values()) curSet.add(c);
    for (const v of invRows) {
      const raw = String(v.currency ?? "").trim();
      if (isValidCurrency(raw)) curSet.add(raw.toUpperCase());
    }
    if (curSet.size === 0) curSet.add(viewCurrency);
    // Facturas sin moneda explícita válida: excluidas de toda sección
    // (nunca heredan). Se avisan en la UI con su monto para fijarlas en origen.
    unassignedInvoices = invRows.filter((v) => !isValidCurrency(String(v.currency ?? "")));
    unassignedMinor = unassignedInvoices.reduce(
      (acc, v) => acc + (Math.max(0, Math.round(Number(v.amount_minor ?? 0) || 0))),
      0,
    );
    // Base primero, resto alfabético.
    const currencies = [...curSet].sort((a, b) => (a === viewCurrency ? -1 : b === viewCurrency ? 1 : a.localeCompare(b)));

    const today00 = (() => {
      const n = new Date();
      return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
    })();

    const screenNameByAll = new Map<string, string>();
    const advNameByAll = new Map<string, string>();
    {
      const sids = [...new Set(lineRows.map((l) => String(l.screen_id ?? "")).filter(Boolean))];
      if (sids.length > 0) {
        const { data: scData } = await db
          .from("inv_screens")
          .select("id,name,external_ref")
          .eq("store_id", active.id)
          .in("id", sids);
        for (const s of ((scData ?? []) as Array<Record<string, unknown>>)) {
          const ref = String(s.external_ref ?? "").trim();
          const label = String(s.name ?? "").trim() || ref || "Sin nombre";
          screenNameByAll.set(String(s.id), ref ? `${label} (${ref})` : label);
        }
      }
      const aids = [...new Set([...advIdByIo.values()].filter(Boolean) as string[])];
      if (aids.length > 0) {
        const { data: coData } = await db
          .from("crm_companies")
          .select("id,name")
          .eq("store_id", active.id)
          .in("id", aids);
        for (const c of ((coData ?? []) as Array<Record<string, unknown>>)) {
          advNameByAll.set(String(c.id), String(c.name ?? "") || "Sin nombre");
        }
      }
    }

    finBy = currencies.map((cur) => {
      // Contratado en esta moneda: cada línea hereda la moneda de su IO.
      const finOrders = lineRows
        .filter((r) => currencyByIo.get(String(r.io_id ?? "")) === cur)
        .map((r) => ({
          total_amount: Number(r.rate_minor ?? 0),
          currency: cur,
          placed_at: (r.starts_at as string | null) ?? null,
        }));
      const buckets = bucketMonthly(finOrders, cur);
      const kpis = computeFinanceKpis(finOrders, cur);

      // Cobro en esta moneda: la factura cuenta solo si su moneda
      // explícita coincide (invoiceMatchesOrder). Sin herencia silenciosa.
      let invoicedMinor = 0;
      let paidMinor = 0;
      let overdueMinor = 0;
      let overdueCount = 0;
      for (const v of invRows) {
        if (!invoiceMatchesOrder(v.currency, cur)) continue;
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
      const pendingMinor = Math.max(0, invoicedMinor - paidMinor);

      // Tops por contratado (solo esta moneda).
      const grossByBrand = new Map<string, { gross: number; ios: Set<string> }>();
      const grossByAdv = new Map<string, { gross: number; ios: Set<string> }>();
      const grossByScreen = new Map<string, { gross: number; lines: number }>();
      for (const l of lineRows) {
        const ioId = String(l.io_id ?? "");
        if (currencyByIo.get(ioId) !== cur) continue;
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
        const sid = String(l.screen_id ?? "");
        if (sid) {
          const s = grossByScreen.get(sid) ?? { gross: 0, lines: 0 };
          s.gross += amt;
          s.lines += 1;
          grossByScreen.set(sid, s);
        }
      }
      const topBrands = [...grossByBrand.entries()]
        .map(([brand, v]) => ({ brand, gross: v.gross, ios: v.ios.size }))
        .sort((a, b) => b.gross - a.gross)
        .slice(0, 10);
      const topAdvertisers = [...grossByAdv.entries()]
        .map(([id, v]) => ({ name: advNameByAll.get(id) || "Sin nombre", gross: v.gross, ios: v.ios.size }))
        .sort((a, b) => b.gross - a.gross)
        .slice(0, 10);
      const ranked = [...grossByScreen.entries()]
        .map(([id, v]) => ({ name: screenNameByAll.get(id) ?? "Sin nombre", gross: v.gross, lines: v.lines }))
        .sort((a, b) => b.gross - a.gross);
      return {
        currency: cur,
        buckets,
        kpis,
        invoicedMinor,
        paidMinor,
        pendingMinor,
        overdueMinor,
        overdueCount,
        topBrands,
        topAdvertisers,
        topScreens: ranked.slice(0, 5),
        bottomScreens: ranked.slice(-5).reverse(),
      };
    });
    // ?moneda= inválida → Todas (nunca vista vacía por typo).
    activeMoneda = finBy.some((f) => f.currency === monedaParam) ? monedaParam : null;
    visibleFin = activeMoneda ? finBy.filter((f) => f.currency === activeMoneda) : finBy;
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudieron cargar los datos.";
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
      <AutoRefresh ms={60_000} />
      <PageHeader
        eyebrow="Dinero y cobro"
        title={`Finanzas · ${displayStoreName(active)}`}
        description="Qué está contratado, qué se facturó y qué falta cobrar. Cada moneda se muestra por separado."
      />

      {error && (
        <AppCardState>{error}</AppCardState>
      )}

      {unassignedMinor > 0 && (
        <AppCard tone="amber">
          <p className="flex items-start gap-2.5 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <span>
              {formatNumber(unassignedInvoices.length)}{" "}
              {unassignedInvoices.length === 1 ? "factura sin" : "facturas sin"} moneda definida —{" "}
              {formatMoney(unassignedMinor, viewCurrency)} quedaron fuera de los totales. Asígnales una moneda para incluirlas.
            </span>
          </p>
        </AppCard>
      )}

      <div className="flex flex-wrap items-center gap-2.5" role="search" aria-label="Filtros de finanzas">
        <CurrencyFilter value={activeMoneda ?? "all"} currencies={finBy.map((f) => f.currency)} />
      </div>

      {visibleFin.map((fin) => {
        // Una sola moneda visible: el encabezado "Moneda X / base/secundaria"
        // es ruido (los montos ya llevan su símbolo). Solo para distinguir
        // cuando se ven varias monedas a la vez.
        const showCurrencyChrome = finBy.length > 1 && !activeMoneda;
        const closed = fin.buckets.slice(0, -1);
        const bestKey = closed.length > 0 ? closed.reduce((a, b) => (b.salesMinor > a.salesMinor ? b : a)).key : null;
        const worstKey = closed.length > 0 ? closed.reduce((a, b) => (b.salesMinor < a.salesMinor ? b : a)).key : null;
        return (
          <section key={fin.currency} aria-label={`Finanzas ${fin.currency}`} className="flex flex-col gap-8">
            {showCurrencyChrome && (
              <SectionHeading
                title={`Moneda ${fin.currency}`}
                hint={fin.currency === viewCurrency ? "Moneda base de la tienda." : "Moneda secundaria de órdenes."}
                tone="sky"
              />
            )}
            {fin.kpis && (
              <FinanceStrip
                buckets={fin.buckets}
                kpis={fin.kpis}
                currency={fin.currency}
              />
            )}

            {fin.kpis && (
              <section aria-label={showCurrencyChrome ? `Cobro ${fin.currency}` : "Cobro"}>
                <SectionHeading
                  title={showCurrencyChrome ? `Cobro · ${fin.currency}` : "Cobro"}
                  hint="Facturado, cobrado y lo que sigue pendiente."
                  tone="emerald"
                />
                <MetricRow columns={4}>
                  <Metric
                    label="Facturado"
                    icon={FileText}
                    value={formatMoney(fin.invoicedMinor, fin.currency)}
                    hint="Total emitido"
                  />
                  <Metric
                    label="Cobrado"
                    icon={BadgeCheck}
                    value={formatMoney(fin.paidMinor, fin.currency)}
                    hint="Pagos confirmados"
                    tone="success"
                  />
                  <Metric
                    label="Pendiente"
                    icon={Hourglass}
                    value={formatMoney(fin.pendingMinor, fin.currency)}
                    hint="Facturado por cobrar"
                    tone={fin.pendingMinor > 0 ? "warning" : "default"}
                  />
                  <Metric
                    label="Vencido"
                    icon={TriangleAlert}
                    value={formatMoney(fin.overdueMinor, fin.currency)}
                    hint={`${formatNumber(fin.overdueCount)} ${fin.overdueCount === 1 ? "factura" : "facturas"}`}
                    tone={fin.overdueMinor > 0 ? "danger" : "default"}
                  />
                </MetricRow>
              </section>
            )}

            {(fin.topScreens.length > 0 || fin.bottomScreens.length > 0) && (
              <section aria-label={showCurrencyChrome ? `Qué más y qué menos vende ${fin.currency}` : "Qué más y qué menos vende"}>
                <SectionHeading
                  title={showCurrencyChrome ? `Qué más y qué menos vende · ${fin.currency}` : "Qué más y qué menos vende"}
                  hint="Por pantalla, según lo contratado."
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
                        {fin.topScreens.map((r) => (
                          <DataTableRow key={r.name}>
                            <DataTableTd>{r.name}</DataTableTd>
                            <DataTableTd numeric>{formatNumber(r.lines)}</DataTableTd>
                            <DataTableTd numeric>{formatMoney(r.gross, fin.currency)}</DataTableTd>
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
                        {fin.bottomScreens.map((r) => (
                          <DataTableRow key={r.name}>
                            <DataTableTd>{r.name}</DataTableTd>
                            <DataTableTd numeric>{formatNumber(r.lines)}</DataTableTd>
                            <DataTableTd numeric>{formatMoney(r.gross, fin.currency)}</DataTableTd>
                          </DataTableRow>
                        ))}
                      </DataTableBody>
                    </DataTable>
                  </AppCard>
                </div>
              </section>
            )}

            {fin.buckets.length > 0 && (
              <section aria-label={`Detalle mensual ${fin.currency}`}>
                <SectionHeading
                  title={`Contratado mensual · ${fin.currency}`}
                  hint="Mejor y peor mes, sin contar el mes en curso."
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
                      {[...fin.buckets].reverse().map((b, i) => (
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
                          <DataTableTd numeric>{formatMoney(b.salesMinor, fin.currency)}</DataTableTd>
                          <DataTableTd numeric>{formatNumber(b.orders)}</DataTableTd>
                          <DataTableTd numeric>
                            {b.orders > 0
                              ? formatMoney(Math.round(b.salesMinor / b.orders), fin.currency)
                              : "—"}
                          </DataTableTd>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                </AppCard>
              </section>
            )}

            {fin.topBrands.length > 0 && (
              <section aria-label={`Top marcas ${fin.currency}`}>
                <SectionHeading
                  title={`Top marcas por contratado · ${fin.currency}`}
                  hint="Monto contratado por marca."
                  tone="violet"
                />
                <AppCard variant="table">
                  <DataTable>
                    <DataTableHeader>
                      <DataTableTh>Marca</DataTableTh>
                      <DataTableTh numeric>Órdenes</DataTableTh>
                      <DataTableTh numeric>Contratado</DataTableTh>
                    </DataTableHeader>
                    <DataTableBody className="tabular-nums">
                      {fin.topBrands.map((r) => (
                        <DataTableRow key={r.brand}>
                          <DataTableTd>{r.brand}</DataTableTd>
                          <DataTableTd numeric>{formatNumber(r.ios)}</DataTableTd>
                          <DataTableTd numeric>{formatMoney(r.gross, fin.currency)}</DataTableTd>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                </AppCard>
              </section>
            )}

            {fin.topAdvertisers.length > 0 && (
              <section aria-label={`Top anunciantes ${fin.currency}`}>
                <SectionHeading
                  title={`Top anunciantes por contratado · ${fin.currency}`}
                  hint="Monto contratado por empresa anunciante."
                  tone="emerald"
                />
                <AppCard variant="table">
                  <DataTable>
                    <DataTableHeader>
                      <DataTableTh>Anunciante</DataTableTh>
                      <DataTableTh numeric>Órdenes</DataTableTh>
                      <DataTableTh numeric>Contratado</DataTableTh>
                    </DataTableHeader>
                    <DataTableBody className="tabular-nums">
                      {fin.topAdvertisers.map((r) => (
                        <DataTableRow key={r.name}>
                          <DataTableTd>{r.name}</DataTableTd>
                          <DataTableTd numeric>{formatNumber(r.ios)}</DataTableTd>
                          <DataTableTd numeric>{formatMoney(r.gross, fin.currency)}</DataTableTd>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                </AppCard>
              </section>
            )}
          </section>
        );
      })}
    </div>
  );
}
