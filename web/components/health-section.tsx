"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { SectionHeading } from "@/components/section-heading";
import { Button } from "@/components/ui/button";
import { formatNumber, formatPercentPoints } from "@/lib/format";
import { withMarketParam } from "@/lib/markets";

export interface HealthInitial {
  duplicateCount: number;
  enrichPending: number;
  /** Solo display estático (vive en la foto del motor, se actualiza al navegar). */
  sinCanal: number;
  buyers: number;
}

/** Intervalo de refresco en vivo (el enriquecimiento masivo mueve el número). */
const POLL_MS = 15_000;

/**
 * "Salud de tu cartera" reactiva: pinta los valores del servidor y luego
 * refresca duplicados/pendientes/compradores contra /api/health cada 15s
 * (y al volver a la pestaña). Sin esto el número queda congelado en la
 * carga aunque el enrichment avance en fondo.
 */
export function HealthSection({
  storeId,
  marketId,
  initial,
}: {
  storeId: string;
  marketId: string | null;
  initial: HealthInitial;
}) {
  const [live, setLive] = useState<HealthInitial>(initial);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Vuelo en curso: si el tick anterior sigue vivo, el nuevo se salta
  // (evita solapar fetches lentos cada 15s).
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    try {
      const qs = new URLSearchParams({ store: storeId });
      if (marketId) qs.set("market", marketId);
      const r = await fetch(`/api/health?${qs.toString()}`, { cache: "no-store", signal: ctrl.signal });
      if (!r.ok) return;
      const j = (await r.json()) as {
        duplicateCount?: number;
        enrichPending?: number;
        buyers?: number;
      };
      setLive((prev) => ({
        ...prev,
        duplicateCount: typeof j.duplicateCount === "number" ? j.duplicateCount : prev.duplicateCount,
        enrichPending: typeof j.enrichPending === "number" ? j.enrichPending : prev.enrichPending,
        buyers: typeof j.buyers === "number" ? j.buyers : prev.buyers,
      }));
    } catch {
      // Poll best-effort: el próximo intervalo reintenta (abort incluido).
    } finally {
      if (inFlight.current === ctrl) inFlight.current = null;
    }
  }, [storeId, marketId]);

  useEffect(() => {
    timer.current = setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer.current) clearInterval(timer.current);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [refresh]);

  const { duplicateCount, enrichPending, buyers } = live;
  const sinCanal = initial.sinCanal;
  const healthPct =
    buyers > 0
      ? Math.max(
          0,
          Math.min(100, Math.round(((buyers - duplicateCount - enrichPending - sinCanal) / buyers) * 100)),
        )
      : 0;

  return (
    <section aria-label="Salud de tu cartera">
      <SectionHeading
        title="Salud de tu cartera"
        hint="Para que el equipo IA trabaje con datos limpios."
        tone="emerald"
      />
      <AppCard contentClassName="flex flex-col gap-3">
        {duplicateCount === 0 && enrichPending === 0 && sinCanal === 0 ? (
          <p className="inline-flex items-center gap-2 text-[13px] text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            Cartera limpia — sin duplicados, sin dominios pendientes y con canal utilizable.
          </p>
        ) : (
          <>
            {duplicateCount > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-amber-500/50 pl-3">
                <p className="text-[13px]">
                  <strong>{formatNumber(duplicateCount)}</strong>{" "}
                  {duplicateCount === 1 ? "email duplicado" : "emails duplicados"}: el mismo
                  contacto en más de una ficha parte el historial y el RFM.
                </p>
                <Button render={<Link href="/customers/duplicates" />} nativeButton={false} size="sm">
                  Revisar duplicados
                </Button>
              </div>
            )}
            {enrichPending > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-sky-500/50 pl-3">
                <p className="text-[13px]">
                  <strong>{formatNumber(enrichPending)}</strong>{" "}
                  {enrichPending === 1 ? "dominio sin enriquecer" : "dominios sin enriquecer"}: sin
                  empresa e industria el Estratega y el Redactor trabajan a ciegas.
                </p>
                <Button render={<Link href="/customers" />} nativeButton={false} size="sm">
                  Enriquecer en Customers
                </Button>
              </div>
            )}
            {sinCanal > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-rose-500/50 pl-3">
                <p className="text-[13px]">
                  <strong>{formatNumber(sinCanal)}</strong>{" "}
                  {sinCanal === 1 ? "cliente" : "clientes"} sin canal utilizable: el motor no puede escribirles.
                </p>
                <Button render={<Link href={withMarketParam("/customers?decision=sin_canal", marketId)} />} nativeButton={false} size="sm">
                  Ver sin canal
                </Button>
              </div>
            )}
          </>
        )}
        {buyers > 0 && (
          <div className="mt-1 flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <div
                className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`Cartera lista: ${formatPercentPoints(healthPct)}`}
              >
                <div
                  className="h-full rounded-full bg-emerald-500/80"
                  style={{ width: `${healthPct}%` }}
                />
              </div>
              <span className="text-xs font-medium text-emerald-600 tabular-nums dark:text-emerald-400">
                {formatPercentPoints(healthPct)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatPercentPoints(healthPct)} de cartera lista ({formatNumber(buyers)} con compras)
            </p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          La base por ritmo de recompra vive en{" "}
          <Link href={withMarketParam("/customers?ritmo=con-ritmo", marketId)} className="underline">
            Customers (filtro por ritmo)
          </Link>
          .
        </p>
      </AppCard>
    </section>
  );
}
