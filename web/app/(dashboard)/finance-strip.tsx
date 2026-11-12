import { Receipt, ShoppingCart, TrendingUp } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Metric, MetricRow } from "@/components/metric";
import { Money } from "@/components/money";
import { AppTooltip } from "@/components/ui/app-tooltip";
import type { FinanceKpis, MonthBucket } from "@/lib/finance";
import { formatMoney, formatNumber } from "@/lib/format";

/**
 * Facturación 12m: ventas (línea) + órdenes (barras), una sola escala.
 * Tramo final al mes en curso: punteado tenue. SVG hecho a mano, sin ejes Y.
 */
function Trend({ buckets, currency }: { buckets: MonthBucket[]; currency: string | null }) {
  const W = 600;
  const H = 96;
  const BASE = H - 16;
  const TOP = 10;
  const PLOT_H = BASE - TOP;
  const PAD = 8;
  const salesMax = Math.max(1, ...buckets.map((b) => b.salesMinor));
  const maxOrders = Math.max(...buckets.map((b) => b.orders), 1);
  const slot = (W - PAD * 2) / buckets.length;
  const barW = Math.min(14, slot * 0.35);
  const ySales = (v: number) => BASE - (v / salesMax) * PLOT_H;
  const salesPts = buckets.map((b, i) => {
    const cx = PAD + slot * i + slot / 2;
    return `${cx.toFixed(1)},${ySales(b.salesMinor).toFixed(1)}`;
  });
  const empty = buckets.every((b) => b.salesMinor === 0);
  const xLabels = (
    <>
      {buckets.map((b, i) => {
        const cx = PAD + slot * i + slot / 2;
        return (
          <text
            key={`v-${b.key}`}
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
  const ventasTip = (i: number) =>
    `${buckets[i].label}${i === buckets.length - 1 ? " (en curso)" : ""}: ${formatMoney(buckets[i].salesMinor, currency)} · ${formatNumber(buckets[i].orders)} órdenes`;
  const overlayCols = `repeat(${buckets.length}, minmax(0, 1fr))`;
  return (
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
          {xLabels}
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
  );
}

export function FinanceStrip({
  buckets,
  kpis,
  currency,
}: {
  buckets: MonthBucket[];
  kpis: FinanceKpis;
  currency: string | null;
}) {
  const total12 = buckets.reduce((a, b) => a + b.salesMinor, 0);
  if (total12 === 0 && kpis.ordersMes === 0) return null;
  return (
    <section aria-label="Salud del negocio" className="flex flex-col gap-4">
      <MetricRow columns={3} aria-label="Salud del negocio · mes en curso">
        <Metric
          label="Ventas mes"
          icon={TrendingUp}
          value={<Money amountMinor={kpis.salesMesMinor} currency={currency} />}
          delta={kpis.salesDeltaPct}
          deltaLabel="vs mismo tramo mes ant."
        />
        <Metric
          label="Órdenes mes"
          icon={ShoppingCart}
          value={formatNumber(kpis.ordersMes)}
          delta={kpis.ordersDeltaPct}
          deltaLabel="vs mismo tramo mes ant."
        />
        <Metric
          label="Ticket medio"
          icon={Receipt}
          value={<Money amountMinor={kpis.ticketMesMinor} currency={currency} />}
          hint="Por orden, mes en curso"
        />
      </MetricRow>
      <AppCard
        title="Facturación · últimos 12 meses"
        contentClassName="flex flex-col gap-4"
      >
        <Trend buckets={buckets} currency={currency} />
        <p className="text-xs text-muted-foreground tabular-nums">
          {(() => {
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
          Tramo punteado = mes en curso (parcial).
        </p>
      </AppCard>
    </section>
  );
}
