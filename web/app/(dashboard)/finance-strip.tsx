import { AppCard } from "@/components/app-card";
import { AppTooltip } from "@/components/ui/app-tooltip";
import type { FinanceKpis, MonthBucket, RescateBucket, RetentionKpis } from "@/lib/finance";
import { formatMoney, formatNumber, formatPercentPoints } from "@/lib/format";

function Delta({ pct }: { pct: number | null }) {
  if (pct === null)
    return <span className="text-xs text-muted-foreground">sin base previa</span>;
  if (pct === 0) return <span className="text-xs text-muted-foreground">igual que antes</span>;
  const up = pct > 0;
  return (
    <span className={`text-xs tabular-nums ${up ? "text-green-600" : "text-red-500"}`}>
      {up ? "▲" : "▼"} {formatPercentPoints(Math.abs(pct))} vs 30d previos
    </span>
  );
}

/**
 * Dos charts sleek, una escala cada uno (nunca se mezclan):
 * 1. Facturación: ventas (línea) + órdenes (barras).
 * 2. Recupero: en juego (sólida) + rescatado (barras), misma escala
 *    → el gap es la fuga. Tramo final al mes en curso: punteado tenue.
 *    SVG hecho a mano, sin ejes Y.
 */
function Trend({
  buckets,
  rescate,
  currency,
}: {
  buckets: MonthBucket[];
  rescate?: RescateBucket[] | null;
  currency: string | null;
}) {
  const W = 600;
  const H = 96;
  const BASE = H - 16;
  const TOP = 10;
  const PLOT_H = BASE - TOP;
  const PAD = 8;
  const fused = rescate && rescate.length === buckets.length ? rescate : null;
  const salesMax = Math.max(1, ...buckets.map((b) => b.salesMinor));
  const juegoMax = fused
    ? Math.max(1, ...fused.flatMap((b) => [b.enJuegoMinor, b.rescatadoMinor]))
    : 1;
  const maxOrders = Math.max(...buckets.map((b) => b.orders), 1);
  const slot = (W - PAD * 2) / buckets.length;
  const barW = Math.min(14, slot * 0.35);
  const ySales = (v: number) => BASE - (v / salesMax) * PLOT_H;
  const yJuego = (v: number) => BASE - (v / juegoMax) * PLOT_H;
  const hJuego = (v: number) => (v / juegoMax) * PLOT_H;
  const salesPts = buckets.map((b, i) => {
    const cx = PAD + slot * i + slot / 2;
    return `${cx.toFixed(1)},${ySales(b.salesMinor).toFixed(1)}`;
  });
  // Fugado = en juego − rescatado (nunca negativo). En el chart de recupero
  // va como gap entre punteada y barra; el número exacto vive en el tooltip.
  const fugadoOf = (b: RescateBucket) => Math.max(0, b.enJuegoMinor - b.rescatadoMinor);
  const juegoPts = fused
    ? fused.map((b, i) => {
        const cx = PAD + slot * i + slot / 2;
        return `${cx.toFixed(1)},${yJuego(b.enJuegoMinor).toFixed(1)}`;
      })
    : null;
  const empty = buckets.every((b) => b.salesMinor === 0);
  const xLabels = (keySuffix: string) => (
    <>
      {buckets.map((b, i) => {
        const cx = PAD + slot * i + slot / 2;
        return (
          <text
            key={`${keySuffix}-${b.key}`}
            x={cx}
            y={H - 4}
            textAnchor="middle"
            className="fill-muted-foreground opacity-50"
            fontSize={8}
          >
            {b.label}
          </text>
        );
      })}
    </>
  );
  // SSOT tooltips (app-tooltip.tsx): prohibido `title=` nativo. El SVG solo
  // dibuja; el hover vive en un overlay HTML con AppTooltip (shadcn).
  // Último mes = en curso (parcial): se marca en el tip.
  const ventasTip = (i: number) =>
    `${buckets[i].label}${i === buckets.length - 1 ? " (en curso)" : ""}: ${formatMoney(buckets[i].salesMinor, currency)} · ${formatNumber(buckets[i].orders)} órdenes`;
  const recuperoTip = (i: number) => {
    const fv = fused?.[i];
    if (!fv) return buckets[i].label;
    const curso = i === buckets.length - 1 ? " (en curso)" : "";
    return `${buckets[i].label}${curso}: en juego ${formatMoney(fv.enJuegoMinor, currency)} (${fv.origenEnJuego === "motor" ? "motor" : "histórico"}) · rescatado ${formatMoney(fv.rescatadoMinor, currency)} · fugado ${formatMoney(fugadoOf(fv), currency)} · ${formatNumber(buckets[i].orders)} órdenes (${formatMoney(buckets[i].salesMinor, currency)} vendidos)`;
  };
  const overlayCols = `repeat(${buckets.length}, minmax(0, 1fr))`;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Facturación</span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span aria-hidden className="inline-block h-0.5 w-3 bg-primary" /> Ventas
            </span>
            <span className="flex items-center gap-1">
              <span aria-hidden className="inline-block h-2 w-1.5 rounded-sm bg-primary/20" /> Órdenes
            </span>
          </span>
        </div>
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            role="img"
            aria-label={
              empty
                ? "Sin ventas en los últimos 12 meses"
                : `Ventas 12 meses: ${buckets.map((b) => `${b.label} ${formatMoney(b.salesMinor, currency)}`).join(", ")}`
            }
          >
            {buckets.map((b, i) => {
              const cx = PAD + slot * i + slot / 2;
              return (
                <rect
                  key={b.key}
                  x={cx - barW / 2}
                  y={BASE - (b.orders / maxOrders) * PLOT_H}
                  width={barW}
                  height={(b.orders / maxOrders) * PLOT_H}
                  rx={2}
                  className="fill-primary/15"
                />
              );
            })}
            {xLabels("v")}
            {!empty && salesPts.length > 1 && (
              <polyline
                points={salesPts.slice(0, -1).join(" ")}
                fill="none"
                className="stroke-primary"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {!empty && salesPts.length > 1 && (
              <polyline
                points={salesPts.slice(-2).join(" ")}
                fill="none"
                className="stroke-primary opacity-60"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {!empty &&
              salesPts.map((pt, i) => {
                const [cx, cy] = pt.split(",").map(Number);
                const isCurrent = i === salesPts.length - 1;
                return (
                  <circle
                    key={`vs-${buckets[i].key}`}
                    cx={cx}
                    cy={cy}
                    r={isCurrent ? 2.5 : 2}
                    className={isCurrent ? "fill-background stroke-primary" : "fill-primary"}
                    strokeWidth={isCurrent ? 1.5 : 0}
                  />
                );
              })}
          </svg>
          <div
            className="absolute inset-x-2 top-0 bottom-4 grid"
            style={{ gridTemplateColumns: overlayCols }}
          >
            {buckets.map((b, i) => (
              <AppTooltip key={`vt-${b.key}`} tip={ventasTip(i)}>
                <span className="block h-full w-full" />
              </AppTooltip>
            ))}
          </div>
        </div>
      </div>
      {fused && juegoPts && (
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Recupero</span>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <span aria-hidden className="inline-block h-0.5 w-3 bg-amber-500" /> En juego
              </span>
              <span className="flex items-center gap-1">
                <span aria-hidden className="inline-block h-2 w-1.5 rounded-sm bg-emerald-500/60" />{" "}
                Rescatado
              </span>
            </span>
          </div>
          <div className="relative">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="w-full"
              role="img"
              aria-label={`En juego y rescatado 12 meses: ${buckets.map((b, i) => `${b.label}: ${formatMoney(fused[i].rescatadoMinor, currency)} rescatado`).join(", ")}`}
            >
              {buckets.map((b, i) => {
                const cx = PAD + slot * i + slot / 2;
                const fv = fused[i];
                return (
                  <rect
                    key={b.key}
                    x={cx - barW / 2}
                    y={BASE - hJuego(fv.rescatadoMinor)}
                    width={barW}
                    height={hJuego(fv.rescatadoMinor)}
                    rx={2}
                    className="fill-emerald-500/60"
                  />
                );
              })}
              {xLabels("r")}
              <polyline
                points={juegoPts.slice(0, -1).join(" ")}
                fill="none"
                className="stroke-amber-500"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {juegoPts.length > 1 && (
                <polyline
                  points={juegoPts.slice(-2).join(" ")}
                  fill="none"
                  className="stroke-amber-500 opacity-60"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
              {juegoPts.map((pt, i) => {
                const [cx, cy] = pt.split(",").map(Number);
                const isCurrent = i === juegoPts.length - 1;
                return (
                  <circle
                    key={`ej-${buckets[i].key}`}
                    cx={cx}
                    cy={cy}
                    r={isCurrent ? 2.5 : 2}
                    className={isCurrent ? "fill-background stroke-amber-500" : "fill-amber-500"}
                    strokeWidth={isCurrent ? 1.5 : 0}
                  />
                );
              })}
            </svg>
            <div
              className="absolute inset-x-2 top-0 bottom-4 grid"
              style={{ gridTemplateColumns: overlayCols }}
            >
              {buckets.map((b, i) => (
                <AppTooltip key={`rt-${b.key}`} tip={recuperoTip(i)}>
                  <span className="block h-full w-full" />
                </AppTooltip>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function FinanceStrip({
  buckets,
  kpis,
  currency,
  recoveredMinor,
  /** undefined = no se intentó (clásico ventas+órdenes); null = sin ciclo (clásico + nudge);
   *  array = fusionado 1+2 en el mismo chart. */
  rescate,
  cycleDays = null,
  /** Segunda fila de KPIs (retención). undefined = no se muestra. */
  retention,
  /** En juego probabilístico (foto del día: actuar+vigilar). null = respaldo clásico. */
  enJuegoProb = null,
  /** Orgánicos del día (vuelven solos, sin inventar ahorro). */
  organicosEnAuto = null,
}: {
  buckets: MonthBucket[];
  kpis: FinanceKpis;
  currency: string | null;
  /** Ingreso atribuido a recuperación (para el % sobre ventas 30d).
   *  Omitido = se oculta la línea (p. ej. en /finance, que no lo consulta). */
  recoveredMinor?: number;
  rescate?: RescateBucket[] | null;
  cycleDays?: number | null;
  /** Segunda fila de KPIs (retención). undefined = no se muestra. */
  retention?: RetentionKpis | null;
  enJuegoProb?: { minor: number; low: number; high: number; count: number } | null;
  organicosEnAuto?: number | null;
}) {
  const total12 = buckets.reduce((a, b) => a + b.salesMinor, 0);
  if (total12 === 0 && kpis.orders30d === 0) return null;
  const fused = rescate && rescate.length === buckets.length ? rescate : null;
  return (
    <section aria-label="Salud del negocio">
      <AppCard
        title={
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
            Salud del negocio · últimos 12 meses
          </span>
        }
        contentClassName="flex flex-col gap-4"
      >
          <div className={`grid gap-4 ${retention ? "grid-cols-2 lg:grid-cols-5" : "grid-cols-3"}`}>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-muted-foreground">Ventas 30d</span>
              <span className="text-xl font-semibold tabular-nums tracking-tight">
                {formatMoney(kpis.sales30dMinor, currency)}
              </span>
              <Delta pct={kpis.salesDeltaPct} />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-muted-foreground">Órdenes 30d</span>
              <span className="text-xl font-semibold tabular-nums tracking-tight">
                {formatNumber(kpis.orders30d)}
              </span>
              <Delta pct={kpis.ordersDeltaPct} />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-muted-foreground">Ticket medio</span>
              <span className="text-xl font-semibold tabular-nums tracking-tight">
                {formatMoney(kpis.ticket30dMinor, currency)}
              </span>
              <span className="text-xs text-muted-foreground">por orden, 30d</span>
            </div>
            {retention && (
              <>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">Rescatado 30d</span>
                  <span className="text-xl font-semibold tabular-nums tracking-tight">
                    {formatMoney(retention.rescatado30dMinor, currency)}
                  </span>
                  <Delta pct={retention.rescatadoDeltaPct} />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">
                    {enJuegoProb ? "En juego hoy (esperado · actuar + vigilar)" : "En juego hoy (estimación histórica)"}
                  </span>
                  {enJuegoProb ? (
                    <>
                      <span className="text-xl font-semibold tabular-nums tracking-tight">
                        {formatMoney(enJuegoProb.minor, currency)}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatNumber(enJuegoProb.count)}{" "}
                        {enJuegoProb.count === 1 ? "cliente" : "clientes"} · rango{" "}
                        {formatMoney(enJuegoProb.low, currency)}–{formatMoney(enJuegoProb.high, currency)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-xl font-semibold tabular-nums tracking-tight">
                        {formatMoney(retention.enJuegoNowMinor, currency)}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatNumber(retention.enJuegoNowCount)} por volver · ticket medio
                      </span>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <Trend buckets={buckets} rescate={rescate} currency={currency} />
          <p className="text-xs text-muted-foreground tabular-nums">
            {(() => {
              // Issue #12: el % mezclaba atribuido histórico (all-time) contra
              // ventas 30d. Con retention se usa rescatado30d (misma ventana);
              // sin retention se muestra el atribuido total SIN % y etiquetado
              // como atribuido (nunca incremental: sin holdout no hay causalidad).
              const r30 = retention?.rescatado30dMinor ?? null;
              if (r30 !== null && kpis.sales30dMinor > 0) {
                const pct = Math.round((r30 / kpis.sales30dMinor) * 100);
                return r30 > 0
                  ? `Atribuido 30d ${formatMoney(r30, currency)} = ${formatPercentPoints(pct)} de tus ventas 30d (atribuido, no incremental). `
                  : "Aún sin recupero medido — cuando un cliente vuelva, se refleja aquí. ";
              }
              if (recoveredMinor !== undefined) {
                return recoveredMinor > 0
                  ? `Atribuido total ${formatMoney(recoveredMinor, currency)} (histórico; sin % hasta tener ventana 30d. Atribuido, no incremental). `
                  : "Aún sin recupero medido — cuando un cliente vuelva, se refleja aquí. ";
              }
              return "";
            })()}
            {(() => {
              // El ticket cuenta la historia que ventas y órdenes por separado
              // esconden (p. ej. ventas −40% con órdenes +58% = ticket colapsado).
              const closed = buckets.slice(0, -1).filter((b) => b.orders > 0);
              if (closed.length >= 2) {
                const a = closed[closed.length - 2];
                const b = closed[closed.length - 1];
                const ta = a.salesMinor / Math.max(1, a.orders);
                const tb = b.salesMinor / Math.max(1, b.orders);
                if (ta > 0 && (tb - ta) / ta <= -0.3) {
                  return `El ticket cayó de ${formatMoney(Math.round(ta), currency)} a ${formatMoney(Math.round(tb), currency)} entre ${a.label} y ${b.label}: vendes más órdenes por menos plata. `;
                }
              }
              return "";
            })()}
            {(() => {
              // Origen de la serie en juego (issue #12): el motor solo existe
              // desde que corre a diario; los meses anteriores son
              // reconstrucción pre-motor desde órdenes. Se declara el corte.
              const motorDesde = rescate?.find((r) => r.origenEnJuego === "motor");
              const hayPre = (rescate ?? []).some((r) => r.origenEnJuego === "pre-motor");
              if (motorDesde && hayPre) {
                return `En juego con motor desde ${motorDesde.label}; meses anteriores reconstruidos desde órdenes (pre-motor). `;
              }
              return "";
            })()}
            {fused && cycleDays !== null
              ? `Recupero: verde = rescatado; el gap con la línea (en juego, ciclo ~${formatNumber(cycleDays)}d) es tu fuga. Tramo punteado = mes en curso. `
              : "Tramo punteado = mes en curso (parcial). "}
            {organicosEnAuto !== null && organicosEnAuto > 0
              ? `${formatNumber(organicosEnAuto)} volverán solos y no les escribimos. `
              : ""}
            {rescate === null
              ? "Sin ciclo calibrado: enseña tu negocio en Settings para ver en juego vs rescatado. "
              : ""}
          </p>
        </AppCard>
      </section>
  );
}
