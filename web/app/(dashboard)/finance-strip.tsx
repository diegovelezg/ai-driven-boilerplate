import { Card, CardContent } from "@/components/ui/card";
import type { FinanceKpis, MonthBucket, RescateBucket, RetentionKpis } from "@/lib/finance";
import { formatMoney } from "@/lib/medusa";

function Delta({ pct }: { pct: number | null }) {
  if (pct === null)
    return <span className="text-xs text-muted-foreground">sin base previa</span>;
  if (pct === 0) return <span className="text-xs text-muted-foreground">igual que antes</span>;
  const up = pct > 0;
  return (
    <span className={`text-xs tabular-nums ${up ? "text-green-600" : "text-red-500"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct)}% vs 30d previos
    </span>
  );
}

/**
 * El chart del dashboard: ventas (línea) + órdenes (barras).
 * Con rescate (ciclo calibrado) se fusiona el 1+2: barras = rescatado,
 * línea sólida = ventas, línea punteada = en juego — las tres en plata,
 * misma escala, misma moneda. SVG hecho a mano, sin deps.
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
  const H = 150;
  const PAD = 8;
  const fused = rescate && rescate.length === buckets.length ? rescate : null;
  const moneyMax = Math.max(
    1,
    ...buckets.map((b) => b.salesMinor),
    ...(fused ? fused.flatMap((b) => [b.enJuegoMinor, b.rescatadoMinor]) : []),
  );
  const maxOrders = Math.max(...buckets.map((b) => b.orders), 1);
  const slot = (W - PAD * 2) / buckets.length;
  const barW = Math.min(18, slot * 0.4);
  const yOf = (v: number) => H - 22 - (v / moneyMax) * (H - 50);
  const hOf = (v: number) => (v / moneyMax) * (H - 50);
  const salesPts = buckets.map((b, i) => {
    const cx = PAD + slot * i + slot / 2;
    return `${cx.toFixed(1)},${yOf(b.salesMinor).toFixed(1)}`;
  });
  // Fugado = en juego − rescatado (nunca negativo). En el chart va como gap
  // entre la línea punteada (en juego) y la barra verde (rescatado); el número
  // exacto vive en el header y en el tooltip.
  const fugadoOf = (b: RescateBucket) => Math.max(0, b.enJuegoMinor - b.rescatadoMinor);
  const juegoPts = fused
    ? fused.map((b, i) => {
        const cx = PAD + slot * i + slot / 2;
        return `${cx.toFixed(1)},${yOf(b.enJuegoMinor).toFixed(1)}`;
      })
    : null;
  const empty = buckets.every((b) => b.salesMinor === 0);
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={
          empty
            ? "Sin ventas en los últimos 12 meses"
            : fused
              ? `Ventas, rescatado y fugado 12 meses: ${buckets.map((b, i) => `${b.label}: ${fused[i].enJuegoCount} vencidos`).join(", ")}`
              : `Ventas 12 meses: ${buckets.map((b) => `${b.label} ${b.orders}`).join(", ")}`
        }
      >
        {buckets.map((b, i) => {
          const cx = PAD + slot * i + slot / 2;
          const fv = fused?.[i];
          const base = H - 22;
          return (
            <g key={b.key}>
              {fused && fv ? (
                <>
                  <title>{`${b.label}: en juego ${formatMoney(fv.enJuegoMinor, currency)} · rescatado ${formatMoney(fv.rescatadoMinor, currency)} · fugado ${formatMoney(fugadoOf(fv), currency)}`}</title>
                  <rect
                    x={cx - barW / 2}
                    y={base - hOf(fv.rescatadoMinor)}
                    width={barW}
                    height={hOf(fv.rescatadoMinor)}
                    rx={2}
                    className="fill-emerald-500/70"
                  />
                </>
              ) : (
                <>
                  <title>{`${b.label}: ${b.orders} órdenes`}</title>
                  <rect
                    x={cx - barW / 2}
                    y={base - (b.orders / maxOrders) * (H - 50)}
                    width={barW}
                    height={(b.orders / maxOrders) * (H - 50)}
                    rx={2}
                    className="fill-primary/20"
                  />
                </>
              )}
              <text
                x={cx}
                y={H - 8}
                textAnchor="middle"
                className="fill-muted-foreground opacity-60"
                fontSize={8}
              >
                {fused ? `${b.label} · ${b.orders}` : b.label}
                <title>{`${b.label}: ${b.orders} órdenes`}</title>
              </text>
            </g>
          );
        })}
        {!empty && (
          <polyline
            points={salesPts.join(" ")}
            fill="none"
            className="stroke-primary"
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {!empty &&
          salesPts.map((_, i) => {
            const cx = PAD + slot * i + slot / 2;
            return <circle key={i} cx={cx} cy={yOf(buckets[i].salesMinor)} r={1.5} className="fill-primary" />;
          })}
        {fused && !empty && juegoPts && (
          <polyline
            points={juegoPts.join(" ")}
            fill="none"
            className="stroke-amber-500"
            strokeWidth={1.25}
            strokeDasharray="4 3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
      </svg>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-0.5 w-4 bg-primary" /> Ventas
        </span>
        {fused ? (
          <>
            <span className="flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-0 w-4 border-t-2 border-dashed border-amber-500"
              />{" "}
              En juego
            </span>
            <span className="flex items-center gap-1">
              <span aria-hidden className="inline-block h-3 w-2 rounded-sm bg-emerald-500/70" />{" "}
              Rescatado
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1">
            <span aria-hidden className="inline-block h-3 w-2 rounded-sm bg-primary/20" /> Órdenes
          </span>
        )}
      </div>
    </div>
  );
}

export function FinanceStrip({
  buckets,
  kpis,
  currency,
  recoveredMinor,
  marketLabel = null,
  /** undefined = no se intentó (clásico ventas+órdenes); null = sin ciclo (clásico + nudge);
   *  array = fusionado 1+2 en el mismo chart. */
  rescate,
  cycleDays = null,
  /** Segunda fila de KPIs (retención). undefined = no se muestra. */
  retention,
}: {
  buckets: MonthBucket[];
  kpis: FinanceKpis;
  currency: string | null;
  /** Ingreso atribuido a recuperación (para el % sobre ventas 30d).
   *  Omitido = se oculta la línea (p. ej. en /finanzas, que no lo consulta). */
  recoveredMinor?: number;
  marketLabel?: string | null;
  rescate?: RescateBucket[] | null;
  cycleDays?: number | null;
  /** Segunda fila de KPIs (retención). undefined = no se muestra. */
  retention?: RetentionKpis | null;
}) {
  const total12 = buckets.reduce((a, b) => a + b.salesMinor, 0);
  if (total12 === 0 && kpis.orders30d === 0) return null;
  const fused = rescate && rescate.length === buckets.length ? rescate : null;
  const recoveredPct =
    recoveredMinor !== undefined && kpis.sales30dMinor > 0
      ? Math.round((recoveredMinor / kpis.sales30dMinor) * 100)
      : null;
  return (
    <section aria-label="Salud del negocio">
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Salud del negocio · últimos 12 meses{marketLabel ? ` · ${marketLabel}` : ""}
            </span>
          </div>
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
                {kpis.orders30d}
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
                  <span className="text-[11px] text-muted-foreground">En juego hoy</span>
                  <span className="text-xl font-semibold tabular-nums tracking-tight">
                    {formatMoney(retention.enJuegoNowMinor, currency)}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {retention.enJuegoNowCount}{" "}
                    {retention.enJuegoNowCount === 1 ? "vencido" : "vencidos"} × ticket
                  </span>
                </div>
              </>
            )}
          </div>
          <Trend buckets={buckets} rescate={rescate} currency={currency} />
          <span className="text-xs text-muted-foreground tabular-nums">
            {recoveredMinor !== undefined
              ? recoveredMinor > 0 && recoveredPct !== null
                ? `Recuperaste ${formatMoney(recoveredMinor, currency)} = ${recoveredPct}% de tus ventas 30d. `
                : "Aún sin recupero medido — cuando un cliente vuelva, se refleja aquí. "
              : ""}
            {fused && cycleDays !== null
              ? `Verde = rescatado; el gap con la línea punteada (en juego, ciclo ~${cycleDays}d) es tu fuga. `
              : ""}
            {rescate === null
              ? "Sin ciclo calibrado: enseña tu negocio en Settings para ver en juego vs rescatado. "
              : ""}
            Montos en {(currency ?? "PEN").toUpperCase()}; otras monedas van aparte.
          </span>
        </CardContent>
      </Card>
    </section>
  );
}
