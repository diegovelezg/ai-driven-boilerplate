"use client";

import { useEffect, useState } from "react";
import { es } from "react-day-picker/locale";
import { CalendarDays } from "lucide-react";
import { AppCard, AppCardState } from "@/components/app-card";
import { HistoryBadge, OccupancyBadge, UpcomingBadge } from "@/components/badges";
import { RetryButton } from "@/components/buttons";
import { Calendar } from "@/components/ui/calendar";
import { formatDate, formatNumber, parseISODate } from "@/lib/format";
import { addDays, firstFreeDay, todayLima, type OccupiedRange } from "@/lib/availability-utils";

interface OccupancyItem {
  starts: string;
  ends: string;
  io_number: string | null;
  brand: string | null;
  status: string;
  source: "order" | "booking";
}

interface OccupancyData {
  from: string;
  to: string;
  today: string;
  ranges: OccupiedRange[];
  items: OccupancyItem[];
}

const ORDER_STATUS: Record<string, string> = {
  draft: "Borrador",
  signed: "Firmada",
  cancelled: "Cancelada",
};

const BOOKING_STATUS: Record<string, string> = {
  hold: "Hold",
  confirmed: "Confirmada",
  active: "Activa",
  completed: "Completada",
  cancelled: "Cancelada",
};

function statusLabel(it: OccupancyItem): string {
  if (it.source === "booking") return BOOKING_STATUS[it.status] ?? it.status;
  return ORDER_STATUS[it.status] ?? it.status;
}

export function PantallaOcupacion({ screenId }: { screenId: string }) {
  const [data, setData] = useState<OccupancyData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const h = setTimeout(() => {
      fetch(`/api/screens/${screenId}/occupancy?past=90&future=120`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) throw new Error("No se pudo cargar la ocupación.");
          return (await res.json()) as OccupancyData;
        })
        .then((j) => {
          if (!alive) return;
          setData(j);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(e instanceof Error ? e.message : "No se pudo cargar la ocupación.");
        });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [screenId]);

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <AppCardState>{error}</AppCardState>
        <RetryButton
          onRetry={() => {
            setError(null);
            setData(null);
            fetch(`/api/screens/${screenId}/occupancy?past=90&future=120`, { cache: "no-store" })
              .then(async (res) => {
                if (!res.ok) throw new Error("No se pudo cargar la ocupación.");
                return (await res.json()) as OccupancyData;
              })
              .then((j) => setData(j))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : "No se pudo cargar la ocupación."));
          }}
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando ocupación">
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
        <div className="h-16 animate-pulse rounded-lg bg-muted/60" />
      </div>
    );
  }

  const ranges = data.ranges;
  const items = data.items;
  const today = todayLima();
  const horizonEnd = addDays(today, 29);

  const isCovered = (day: string): boolean =>
    ranges.some((r) => r.starts <= day && day <= r.ends);

  let busy30 = 0;
  for (let i = 0; i < 30; i += 1) {
    if (isCovered(addDays(today, i))) busy30 += 1;
  }
  const occPct = Math.round((busy30 / 30) * 100);
  const todayHit = items.find((i) => i.starts <= today && today <= i.ends) ?? null;
  const free = firstFreeDay(ranges, today);

  const booked = ranges.flatMap((r) => {
    const from = parseISODate(r.starts);
    const to = parseISODate(r.ends);
    return from && to ? [{ from, to }] : [];
  });

  const upcoming = items.filter((i) => i.ends >= today).slice(0, 20);
  const next30 = items.filter((i) => i.starts <= horizonEnd && i.ends >= today);
  const history = items
    .filter((i) => i.ends < today)
    .sort((a, b) => (a.ends < b.ends ? 1 : -1))
    .slice(0, 10);
  const historyTotal = items.filter((i) => i.ends < today).length;

  return (
    <div className="flex flex-col gap-4">
      <AppCard title="Próximos 30 días" description={`${formatDate(today)} → ${formatDate(horizonEnd)}`} tone="sky" aria-label="Ocupación próximos 30 días">
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          <div className="min-w-0">
            <p className="truncate text-xs text-muted-foreground">Hoy</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
              {todayHit ? "Ocupada" : "Libre"}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">
              {todayHit
                ? [todayHit.io_number, todayHit.brand].filter(Boolean).join(" · ") || todayHit.source
                : free
                  ? `Libre desde ${formatDate(free)}`
                  : "—"}
            </p>
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs text-muted-foreground">Ocupación 30d</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{occPct}%</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">
              {formatNumber(busy30)} de 30 días ocupados
            </p>
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs text-muted-foreground">Libre desde</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{free ? formatDate(free) : "—"}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">
              {next30.length === 0 ? "Todo libre en 30 días" : `${formatNumber(next30.length)} pauta${next30.length === 1 ? "" : "s"} en 30 días`}
            </p>
          </div>
        </div>
      </AppCard>

      <AppCard title="Calendario" description="Ocupado tachado en rojo. Navega meses para ver el horizonte." tone="sky" aria-label="Calendario de ocupación">
        <Calendar
          mode="single"
          locale={es}
          modifiers={{ booked }}
          modifiersClassNames={{ booked: "bg-destructive/10 text-destructive line-through" }}
        />
        <p className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <CalendarDays className="size-3.5" aria-hidden />
          <span className="mr-1 inline-block size-2.5 rounded-sm bg-destructive/20 align-middle" aria-hidden />
          ocupado · el borrador aparta 7 días, vencido libera solo.
        </p>
      </AppCard>

      <AppCard
        title={`Órdenes próximas${upcoming.length > 0 ? ` (${formatNumber(upcoming.length)})` : ""}`}
        description="Qué la ocupa hacia adelante (hasta 120 días)."
        tone="primary"
        aria-label="Órdenes próximas"
      >
        {upcoming.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border/60">
            {upcoming.map((it, idx) => {
              const within30 = it.starts <= horizonEnd;
              return (
                <li key={`${it.starts}-${it.ends}-${idx}`} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">
                      {[it.io_number, it.brand].filter(Boolean).join(" · ") || (it.source === "booking" ? "Reserva" : "—")}
                    </span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {formatDate(it.starts)} → {formatDate(it.ends)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {within30 && <UpcomingBadge />}
                    <OccupancyBadge status={it.status} source={it.source} label={statusLabel(it)} />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">Libre en todo el horizonte visible (120 días).</p>
        )}
      </AppCard>

      <AppCard
        title={`Historial${historyTotal > 0 ? ` (${formatNumber(historyTotal)})` : ""}`}
        description="Últimas pautas vencidas (90 días atrás)."
        tone="primary"
        aria-label="Historial de ocupación"
      >
        {history.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border/60">
            {history.map((it, idx) => (
              <li key={`${it.starts}-${it.ends}-${idx}`} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">
                    {[it.io_number, it.brand].filter(Boolean).join(" · ") || (it.source === "booking" ? "Reserva" : "—")}
                  </span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {formatDate(it.starts)} → {formatDate(it.ends)}
                  </span>
                </span>
                <HistoryBadge label={statusLabel(it)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">Sin pautas vencidas en los últimos 90 días.</p>
        )}
      </AppCard>
    </div>
  );
}
