import Link from "next/link";
import { connection } from "next/server";
import { Camera, FileText, Package, Plus, Radio, RefreshCw, Wallet, Gauge, type LucideIcon } from "lucide-react";
import { AppCard, AppCardState } from "@/components/app-card";
import { Metric, MetricRow } from "@/components/metric";
import { PageHeader } from "@/components/page-header";
import { SectionHeading } from "@/components/section-heading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { getDashboardSnapshot, type AlertKind } from "@/lib/dashboard";

export const instant = false;

const ALERT_META: Record<AlertKind, { label: string; icon: LucideIcon; className: string }> = {
  sin_om: {
    label: "Sin OM",
    icon: FileText,
    className: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
  material: {
    label: "Material",
    icon: Package,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  sin_evidencia: {
    label: "Sin evidencia",
    icon: Camera,
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  termina_sin_relevo: {
    label: "Sin relevo",
    icon: RefreshCw,
    className: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
};

export default async function DashboardPage() {
  await connection();
  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let snap: Awaited<ReturnType<typeof getDashboardSnapshot>> | null = null;
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
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
              {snap.alerts.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  Sin alertas. Todo lo firmado tiene OM, material aprobado y evidencia.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {snap.alerts.map((a) => (
                    <li key={`${a.kind}-${a.ioId}`}>
                      <Link
                        href={`/orders?order=${a.ioId}`}
                        className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/40"
                      >
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant="secondary"
                              className={`gap-1 font-normal ${ALERT_META[a.kind].className}`}
                            >
                              {(() => {
                                const Icon = ALERT_META[a.kind].icon;
                                return <Icon aria-hidden />;
                              })()}
                              {ALERT_META[a.kind].label}
                            </Badge>
                            <span className="text-sm font-medium">{a.ioNumber}</span>
                            {a.brand && (
                              <span className="truncate text-xs text-muted-foreground">{a.brand}</span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {a.detail}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {a.company ?? "—"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
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
