"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AppCardState } from "@/components/app-card";
import { OccupancyBadge } from "@/components/badges";
import { formatDate, formatNumber } from "@/lib/format";
import { getScreenDayDetailAction, type ScreenDayDetail } from "@/lib/order-actions";

const ORDER_STATUS: Record<string, string> = {
  draft: "Borrador (hold 7d)",
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

/** Desglose de un día-pantalla (quién ocupa): slide-over derecho de la matriz. */
export function OccupancyDayDrawer({
  screenId,
  screenName,
  day,
  onClose,
}: {
  screenId: string;
  screenName: string;
  day: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ScreenDayDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getScreenDayDetailAction({ screenId, day })
      .then((res) => {
        if (!alive) return;
        if (res.ok) setDetail(res);
        else setError(res.message || "No se pudo cargar el día.");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "No se pudo cargar el día.");
      });
    return () => {
      alive = false;
    };
  }, [screenId, day]);

  const pct = detail && detail.capacity > 0 ? Math.round((Math.min(detail.reserved, detail.capacity) / detail.capacity) * 100) : 0;

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{screenName}</SheetTitle>
          <SheetDescription>
            {formatDate(day)} ·{" "}
            {detail
              ? `${formatNumber(detail.reserved)} de ${formatNumber(detail.capacity)} slots ocupados (${pct}%)`
              : "cargando…"}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-6 pb-6">
          {error && <AppCardState>{error}</AppCardState>}
          {!error && !detail && (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando desglose">
              <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-16 animate-pulse rounded-lg bg-muted/60" />
            </div>
          )}
          {detail && detail.lines.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Día libre: los {formatNumber(detail.capacity)} slots están disponibles.
            </p>
          )}
          {detail && detail.lines.length > 0 && (
            <ul className="flex flex-col divide-y divide-border/60">
              {detail.lines.map((l, i) => (
                <li key={`${l.starts}-${l.ends}-${l.io_number ?? "?"}-${i}`} className="flex items-baseline justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">
                      {[l.io_number, l.brand].filter(Boolean).join(" · ") || (l.source === "booking" ? "Reserva" : "—")}
                    </span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {formatDate(l.starts)} → {formatDate(l.ends)} · {formatNumber(l.slots)} slot{l.slots === 1 ? "" : "s"}
                    </span>
                  </span>
                  <OccupancyBadge
                    status={l.status}
                    source={l.source}
                    label={l.source === "booking" ? (BOOKING_STATUS[l.status] ?? l.status) : (ORDER_STATUS[l.status] ?? l.status)}
                  />
                </li>
              ))}
            </ul>
          )}
          <Button render={<Link href="/orders/new" />} nativeButton={false} size="sm" className="self-start">
            <Plus aria-hidden />
            Crear orden
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
