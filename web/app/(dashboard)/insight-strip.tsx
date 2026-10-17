"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Insights, SegmentKey } from "@/lib/insights";
import { formatMoney } from "@/lib/medusa";

// R/F = quintiles 1–5 vs tu tienda (misma regla que la ficha del cliente).
const SEGMENT_TIPS: Record<SegmentKey, string> = {
  "Campeón": "Reciente y frecuente (R≥4 y F≥4). Tus mejores clientes: prioriza retenerlos.",
  "Recurrente": "Compra habitual (R≥3 y F≥3). Vuelven solos, pero vigila que no se enfríen.",
  "Ocasional": "Compra esporádica: ni frecuente ni en riesgo. Oportunidad de activar con una razón para volver.",
  "Nuevo": "Una sola compra y reciente (R≥4). La 2ª compra define si se queda.",
  "En riesgo": "Compraba seguido (F≥3) pero hace tiempo que no vuelve (R≤2). Actúa ya.",
  "Inactivo": "Hace mucho que no compra (R≤2) y con pocas compras. Recuperable con oferta.",
  "Sin compras": "Registrado pero sin compras reales. No entra en el RFM.",
};

const FREQ_TIPS: Record<string, string> = {
  "1 compra": "Compró una vez y nunca volvió. Aquí está tu mayor fuga.",
  "2 compras": "Recompró una vez. Candidato a hábito si vuelve pronto.",
  "3–5": "Comprador habitual. Núcleo de tu recompra.",
  "6+": "Cliente fiel de alta frecuencia. Cuídalo como a un Campeón.",
};

// Un solo tono, de claro (ticket bajo) a sólido (ticket alto).
const TIER_COLORS = ["bg-primary/30", "bg-primary/50", "bg-primary/70", "bg-primary"];

/** Fila compacta: etiqueta + barra + valor en una sola fila. Con href, la etiqueta navega. */
function Bar({
  label,
  count,
  max,
  tip,
  href,
}: {
  label: string;
  count: number;
  max: number;
  tip: string;
  href?: string;
}) {
  const pct = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            href ? (
              <Link
                href={href}
                className="w-24 shrink-0 truncate text-xs text-muted-foreground hover:text-foreground"
              >
                {label}
              </Link>
            ) : (
              <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                {label}
              </span>
            )
          }
        />
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right text-xs font-medium tabular-nums">{count}</span>
    </div>
  );
}

export function InsightStrip({ insights, currency, storeId, marketLabel = null }: { insights: Insights; currency: string | null; storeId?: string; marketLabel?: string | null }) {
  const sp = useSearchParams();
  // Los links conservan el contexto (tienda + filtro global de mercado).
  const keepParams = (extra: string) => {
    const next = new URLSearchParams();
    const store = sp.get("store") ?? storeId ?? null;
    if (store) next.set("store", store);
    const market = sp.get("market");
    if (market) next.set("market", market);
    return `/customers?${extra}${next.toString() ? `&${next.toString()}` : ""}`;
  };
  if (insights.buyers === 0) return null;
  const scopeNoun = marketLabel ?? "tu tienda";
  const segMax = Math.max(...insights.segments.map((s) => s.count), 1);
  const freqMax = Math.max(...insights.freqBuckets.map((b) => b.count), 1);
  const ticket = formatMoney(insights.avgTicketMinor, currency);
  const median = formatMoney(insights.medianTicketMinor, currency);
  // Etiquetas con rangos reales; se ocultan los tramos vacíos (p. ej. cuartiles iguales).
  const bounds = insights.ticketTiers.map((t) =>
    t.upToMinor === null ? null : formatMoney(t.upToMinor, currency),
  );
  const tierRows = insights.ticketTiers
    .map((t, i) => {
      const up = bounds[i];
      const prev = i === 0 ? null : bounds[i - 1];
      const label = up === null ? `> ${prev ?? "—"}` : prev === null ? `≤ ${up}` : `${prev}–${up}`;
      return { ...t, idx: i, label, tip: `Ticket medio ${label}: ${t.count} clientes.` };
    })
    .filter((t) => t.count > 0);
  return (
    <section aria-label="Inteligencia base">
      {insights.byType.length > 1 && (
        <Card className="mb-4">
          <CardContent className="flex flex-col gap-2 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Patrones por tipo · quién vale y quién reincide
            </span>
            <div className="flex flex-col gap-1.5">
              {insights.byType.map((t) => (
                <div key={t.type} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                  <strong className="w-12">{t.type}</strong>
                  <span className="tabular-nums">{t.buyers} compradores</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="tabular-nums">gasto medio {formatMoney(t.avgSpentMinor, currency)}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="tabular-nums">{t.repeatRate}% reincide (2+)</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="tabular-nums">{t.atRiskRate}% en riesgo/inactivo</span>
                </div>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              B2B gasta más pero reincide menos: prioriza su recupero 1-a-1. Industria/tamaño llega cuando el enriquecimiento tenga cobertura.
            </span>
          </CardContent>
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="flex flex-1 flex-col gap-2.5 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Segmentación · {insights.buyers} compradores
            </span>
            {insights.segments.map((s) => (
              <Bar
                key={s.key}
                label={s.key}
                count={s.count}
                max={segMax}
                tip={`${SEGMENT_TIPS[s.key]} Clic para verlos en Customers.`}
                href={keepParams(`segment=${encodeURIComponent(s.key)}`)}
              />
            ))}
            <span className="mt-auto pt-2 text-xs text-muted-foreground">
              RFM por quintiles vs {scopeNoun} (misma regla que la ficha del cliente).
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-1 flex-col gap-2.5 p-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Frecuencia y ticket · mediana {median} · prom. {ticket}
            </span>
            {insights.freqBuckets.map((b, i) => (
              <Bar
                key={b.label}
                label={b.label}
                count={b.count}
                max={freqMax}
                tip={`${FREQ_TIPS[b.label] ?? b.label} Clic para verlos en Customers.`}
                href={keepParams(`freq=${i}`)}
              />
            ))}
            <span className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Ticket medio por cliente
            </span>
            <div
              className="flex h-3 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`Distribución del ticket: ${tierRows.map((t) => `${t.label}: ${t.count}`).join(", ")}`}
            >
              {tierRows.map((t) => (
                <Tooltip key={t.label}>
                  <TooltipTrigger
                    render={
                      <Link
                        href={keepParams(`ticket=${t.idx}`)}
                        aria-label={`${t.tip} Ver en Customers.`}
                        className={`${TIER_COLORS[t.idx]} h-full`}
                        style={{ width: `${(t.count / insights.buyers) * 100}%` }}
                      />
                    }
                  />
                  <TooltipContent>{t.tip} Clic para verlos en Customers.</TooltipContent>
                </Tooltip>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {tierRows.map((t) => (
                <Link
                  key={t.label}
                  href={keepParams(`ticket=${t.idx}`)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <span className={`size-2 rounded-sm ${TIER_COLORS[t.idx]}`} aria-hidden />
                  {t.label} ·{" "}
                  <span className="font-medium tabular-nums">{t.count}</span>
                </Link>
              ))}
            </div>
            <span className="mt-auto pt-2 text-xs text-muted-foreground">
              Frecuencia: ataca el bucket “1 compra”. Ticket en cuartiles: si el prom. supera a
              la mediana, pocos tickets grandes tiran del promedio.
            </span>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
