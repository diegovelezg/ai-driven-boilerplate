import Link from "next/link";
import { connection } from "next/server";
import { Banknote, Gauge, Plus, Radio, RefreshCw, Wallet } from "lucide-react";
import { AppCard, AppCardState } from "@/components/app-card";
import { Metric, MetricRow } from "@/components/metric";
import { PageHeader } from "@/components/page-header";
import { SectionHeading } from "@/components/section-heading";
import { Button } from "@/components/ui/button";
import { loadPageData } from "@/lib/page-data";
import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { getDashboardSnapshot } from "@/lib/dashboard";

export const instant = false;

export default async function DashboardPage() {
  await connection();
  const { data, connected, dbReady, error } = await loadPageData(
    (storeId) => getDashboardSnapshot(storeId).then((snap) => ({ snap })),
    { snap: null as Awaited<ReturnType<typeof getDashboardSnapshot>> | null },
  );
  const { snap } = data;

  return (
    <div className="page-shell max-w-[1200px]">
      <PageHeader
        eyebrow="DOOH"
        title="Hoy"
        description="Comprometido, cobranza, ocupación, relevo y lo que está al aire. Solo indicadores: los bloqueos viven en el Inbox. Los montos son contratados: todavía no representan cobro."
        right={
          <Button render={<Link href="/orders/new" />} nativeButton={false} size="sm">
            <Plus aria-hidden />
            Nueva orden
          </Button>
        }
      />

      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {snap && (
        <>
          <section aria-label="Salud comercial · mes en curso">
            <SectionHeading title="Salud comercial · mes en curso" tone="emerald" />
            <MetricRow columns={5}>
              <Metric
                label="Comprometido mes"
                icon={Wallet}
                value={(() => {
                  const entries = Object.entries(snap.byCurrency ?? {}).filter(([, v]) => v.comprometidoMesMinor > 0);
                  if (entries.length === 0) return "—";
                  return entries.map(([c, v]) => formatMoney(v.comprometidoMesMinor, c)).join(" + ");
                })()}
                hint={(() => {
                  const entries = Object.entries(snap.byCurrency ?? {}).filter(([, v]) => v.comprometidoMesMinor > 0);
                  if (entries.length === 0) return "Sin órdenes en el mes";
                  return entries.map(([c, v]) => `firmado ${formatMoney(v.firmadoMesMinor, c)} · borrador ${formatMoney(v.draftMesMinor, c)}`).join(" · ");
                })()}
                delta={snap.deltas.comprometido}
                deltaLabel="vs mes ant."
              />
              <Metric
                label="Por cobrar"
                icon={Banknote}
                value={(() => {
                  const entries = Object.entries(snap.cobranzaByCurrency ?? {}).filter(([, v]) => v.invoicedMinor > 0);
                  if (entries.length === 0) return "—";
                  return entries.map(([c, v]) => formatMoney(v.pendingMinor, c)).join(" + ");
                })()}
                hint={(() => {
                  const entries = Object.entries(snap.cobranzaByCurrency ?? {}).filter(([, v]) => v.invoicedMinor > 0);
                  if (entries.length === 0) return "Sin cartera abierta";
                  return entries
                    .map(
                      ([c, v]) =>
                        `facturado ${formatMoney(v.invoicedMinor, c)} · cobrado ${formatMoney(v.paidMinor, c)} · vencido ${formatMoney(v.overdueMinor, c)}`,
                    )
                    .join(" · ");
                })()}
                tone={snap.cobranza.overdueMinor > 0 ? "danger" : snap.cobranza.pendingMinor > 0 ? "warning" : "success"}
                delta={snap.deltas.cobranzaPendiente}
                deltaLabel="vs cierre mes ant."
                invertDelta
              />
              <Metric
                label="Ocupación 14d"
                icon={Gauge}
                value={snap.ocupacion14d.ratio === null ? "—" : formatPercent(snap.ocupacion14d.ratio)}
                hint={`${formatNumber(snap.ocupacion14d.slotsVendidos)} de ${formatNumber(snap.ocupacion14d.slotsDisponibles)} slots-día`}
                tone="primary"
              />
              <Metric
                label="Al aire hoy"
                icon={Radio}
                value={`${formatNumber(snap.alAire.ois)} órdenes`}
                hint={`${formatNumber(snap.alAire.pantallas)} pantallas`}
                delta={snap.deltas.alAireOis}
                deltaLabel="vs ayer"
              />
              <Metric
                label="Relevo 30d"
                icon={RefreshCw}
                value={
                  snap.renovacion30d.ratio === null
                    ? "—"
                    : formatPercent(snap.renovacion30d.ratio)
                }
                hint={`${formatNumber(snap.renovacion30d.conRelevo)} de ${formatNumber(snap.renovacion30d.total)} con siguiente orden`}
              />
            </MetricRow>
          </section>

          <AppCard
            title="Huecos vendibles"
            description="Las pantallas con más días libres en los próximos 14 días."
          >
            {snap.huecos.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin pantallas activas.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {snap.huecos.map((h) => (
                  <li key={h.screenId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium">{h.screenName}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatNumber(h.slotsLibres)} slots libres
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p
              className="mt-3 text-xs text-muted-foreground tabular-nums"
              title={snap.truncated ? "Muestra parcial: la fuente se truncó por límite" : undefined}
            >
              {formatNumber(snap.counts.ois)} órdenes vigentes · {formatNumber(snap.counts.screens)} pantallas
              {snap.truncated ? " · muestra parcial" : ""}.
            </p>
          </AppCard>
        </>
      )}
    </div>
  );
}
