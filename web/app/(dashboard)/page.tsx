import Link from "next/link";
import { connection } from "next/server";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { getDashboardSnapshot, type AlertKind } from "@/lib/dashboard";

export const instant = false;

const ALERT_LABEL: Record<AlertKind, string> = {
  sin_om: "Sin OM",
  material: "Material",
  sin_evidencia: "Sin evidencia",
  termina_sin_relevo: "Sin relevo",
};

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums tracking-tight">{value}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{sub}</span>
    </div>
  );
}

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
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="DOOH"
        title="Hoy"
        description="Solo desde la OI: valor comprometido, ocupación, al aire, certificación y relevo. Sin facturación todavía — el bruto es vendido firmado, no cobrado."
        right={
          <Button render={<Link href="/orders/new" />} nativeButton={false} size="sm">
            Nueva orden
          </Button>
        }
      />

      {!connected && <AppCardState>Sin tienda. Importa inventario en /screens.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {snap && (
        <>
          <AppCard
            title="Salud comercial · mes en curso"
            description="Prorrateo lineal por tiempo solapado. Línea completa solo si cae entera en el mes."
            contentClassName="flex flex-col gap-4"
          >
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <Kpi
                label="Comprometido mes"
                value={(() => {
                  const entries = Object.entries(snap.byCurrency ?? {}).filter(([, v]) => v.comprometidoMesMinor > 0);
                  if (entries.length === 0) return "—";
                  return entries.map(([c, v]) => formatMoney(v.comprometidoMesMinor, c)).join(" + ");
                })()}
                sub={(() => {
                  const entries = Object.entries(snap.byCurrency ?? {}).filter(([, v]) => v.comprometidoMesMinor > 0);
                  if (entries.length === 0) return "sin líneas en el mes";
                  return entries.map(([c, v]) => `firmado ${formatMoney(v.firmadoMesMinor, c)} · draft ${formatMoney(v.draftMesMinor, c)}`).join(" · ");
                })()}
              />
              <Kpi
                label="Ocupación 14d"
                value={snap.ocupacion14d.ratio === null ? "—" : formatPercent(snap.ocupacion14d.ratio)}
                sub={`${formatNumber(snap.ocupacion14d.diasVendidos)} / ${formatNumber(snap.ocupacion14d.diasDisponibles)} pantalla-día`}
              />
              <Kpi
                label="Al aire hoy"
                value={`${formatNumber(snap.alAire.ois)} OI`}
                sub={`${formatNumber(snap.alAire.pantallas)} pantallas`}
              />
              <Kpi
                label="Por certificar"
                value={formatNumber(snap.porCertificar)}
                sub="terminadas sin foto-check"
              />
              <Kpi
                label="Relevo 30d"
                value={
                  snap.renovacion30d.ratio === null
                    ? "—"
                    : formatPercent(snap.renovacion30d.ratio)
                }
                sub={`${formatNumber(snap.renovacion30d.conRelevo)} / ${formatNumber(snap.renovacion30d.total)} con siguiente OI`}
              />
            </div>
          </AppCard>

          <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
            <AppCard
              title={`Alertas (${snap.alerts.length})`}
              description="Ordenadas por riesgo: OM → material → evidencia → relevo. Cada una abre su orden."
              variant="table"
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
                            <Badge variant="secondary" className="font-normal">
                              {ALERT_LABEL[a.kind]}
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
              description="Pantallas más libres próximos 14d."
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
              <p className="mt-3 text-xs text-muted-foreground tabular-nums">
                {formatNumber(snap.counts.ois)} OIs vigentes · {formatNumber(snap.counts.screens)} pantallas.
              </p>
            </AppCard>
          </div>
        </>
      )}
    </div>
  );
}
