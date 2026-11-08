import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Camera, Gauge, Plus, Radio, RefreshCw, Wallet } from "lucide-react";
import { AppCard, AppCardState } from "@/components/app-card";
import { Metric, MetricRow } from "@/components/metric";
import { PageHeader } from "@/components/page-header";
import { SectionHeading } from "@/components/section-heading";
import { Button } from "@/components/ui/button";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getMyStoreRole, requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import type { MemberRole } from "@/lib/roles";
import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { getDashboardSnapshot } from "@/lib/dashboard";
import { DashboardAlerts } from "./dashboard-alerts";

export const instant = false;

export default async function DashboardPage() {
  await connection();
  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let snap: Awaited<ReturnType<typeof getDashboardSnapshot>> | null = null;
  let myRole: MemberRole | null = null;
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        myRole = await getMyStoreRole(storeId).catch(() => null);
        snap = await getDashboardSnapshot(storeId);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "No se pudieron cargar los datos.";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="DOOH"
        title="Hoy"
        description="Lo comprometido del mes, qué está al aire y qué falta certificar. Los montos son contratados: todavía no representan cobro."
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
              />
              <Metric
                label="Ocupación 14d"
                icon={Gauge}
                value={snap.ocupacion14d.ratio === null ? "—" : formatPercent(snap.ocupacion14d.ratio)}
                hint={`${formatNumber(snap.ocupacion14d.diasVendidos)} de ${formatNumber(snap.ocupacion14d.diasDisponibles)} pantalla-día`}
                tone="primary"
              />
              <Metric
                label="Al aire hoy"
                icon={Radio}
                value={`${formatNumber(snap.alAire.ois)} órdenes`}
                hint={`${formatNumber(snap.alAire.pantallas)} pantallas`}
              />
              <Metric
                label="Por certificar"
                icon={Camera}
                value={formatNumber(snap.porCertificar)}
                hint="Terminadas sin evidencia fotográfica"
                tone={snap.porCertificar > 0 ? "warning" : "default"}
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

          <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
            <AppCard
              title={`Alertas (${snap.alerts.length})`}
              description="Lo que requiere acción, de mayor a menor riesgo. Cada alerta abre su orden."
              variant="table"
              className="self-start"
            >
              <Suspense fallback={<p className="px-4 py-6 text-sm text-muted-foreground">Cargando alertas…</p>}>
                <DashboardAlerts alerts={snap.alerts} myRole={myRole} />
              </Suspense>
            </AppCard>

            <AppCard
              title="Huecos vendibles"
              description="Las pantallas con más días libres en los próximos 14 días."
              className="self-start"
            >
              {snap.huecos.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin pantallas activas.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {snap.huecos.map((h) => (
                    <li key={h.screenId} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate font-medium">{h.screenName}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatNumber(h.diasLibres)}d libres
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
          </div>
        </>
      )}
    </div>
  );
}
