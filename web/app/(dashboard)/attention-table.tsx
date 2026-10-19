"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { proposeSingleAction } from "@/lib/review-actions";
import { useBackground } from "@/components/background-status";
import { isJudgeVetoMessage } from "@/lib/single-audit";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EditableCustomer } from "@/lib/customers-db";
import { formatMoney } from "@/lib/medusa";
import { formatNumber } from "@/lib/format";
import { useBackgroundOrNull } from "@/components/background-status";
import { SectionLoading } from "@/components/section-loading";
import { CustomerDrawer } from "./customers/customer-drawer";

export interface AttentionItem {
  signalId: string;
  customerDbId: string;
  kind: string;
  score: number | null;
  reason: string | null;
  /** Días sin comprar (null = otros tipos de señal). Para el ranking por valor. */
  daysSince: number | null;
  /** Último borrador de la señal (define el CTA: Redactar/Revisar/estado). */
  draftStatus: "none" | "pending" | "approved" | "dispatched";
  email: string;
  name: string;
  ordersCount: number;
  totalSpent: number;
  /** Predicción del día (opcionales: sin predicción la fila cae al formato actual). */
  decision?: string | null;
  tDays?: number | null;
  p25Days?: number | null;
  p75Days?: number | null;
  pRecompraH?: number | null;
  ticketEsperadoMinor?: number | null;
  /** Valor esperado (criterio del ranking; el embudo lo muestra, no el ticket histórico). */
  valorEsperadoMinor?: number | null;
  predCurrency?: string | null;
  confidence?: string | null;
  /** Veto del juez de contactabilidad (issue #16 Fase 1): si
   *  `eligible===false`, la fila muestra `Omitido por juez` desactivado
   *  con `reason` como tooltip, nunca `Redactar`. El veto vence por TTL
   *  (ver `parseContactability`): vencido llega como `null` y se rejuzga. */
  contactability?: { eligible: boolean; reason: string | null; at: string | null } | null;
}

export function AttentionTable({
  rows,
  currency,
}: {
  rows: AttentionItem[];
  currency: string | null;
}) {
  const [selected, setSelected] = useState<EditableCustomer | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  // Lock por señal (Fase 3 + P2): cada fila rastrea su propio vuelo; el
  // servidor frena lo incompatible (misma señal, bulk, regenerate, sync).
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [draftError, setDraftError] = useState<{ id: string; message: string } | null>(null);
  const router = useRouter();
  const { start } = useBackground();

  // La fila habla tratamiento (qué hago), no identidad. Sin predicción del
  // motor, la antigüedad decide: lo vencido va 1-a-1, lo antiguo a masiva.
  const tierOf = (row: AttentionItem): { text: string; hot: boolean } => {
    if (row.daysSince === null || row.daysSince <= 365) return { text: "Para contactar", hot: false };
    return { text: "Reactivación masiva", hot: false };
  };

  const open = async (row: AttentionItem) => {
    if (loadingId) return;
    setLoadingId(row.customerDbId);
    try {
      const res = await fetch(`/api/customers/${row.customerDbId}/summary`);
      if (!res.ok) return;
      const j = (await res.json()) as { customer?: EditableCustomer };
      if (j.customer) setSelected(j.customer);
    } finally {
      setLoadingId(null);
    }
  };

  const redact = async (row: AttentionItem) => {
    if (busyIds.includes(row.signalId)) return;
    setBusyIds((prev) => [...prev, row.signalId]);
    setDraftError(null);
    try {
      // Por `useBackground().start`: el intento suma a la cinta global.
      const r = await start(async () => {
        const x = await proposeSingleAction(row.signalId);
        return { ok: x.ok, message: x.message, run: x.run ?? null };
      });
      if (r.ok) {
        router.refresh();
        return;
      }
      // Issue #16 Fase 1: no descartar `r.message` (trae "Ya tiene
      // borrador…" / veto del juez). Se muestra tal cual.
      setDraftError({ id: row.signalId, message: r.message });
      // El veto escribe `evidence_json.contactability` en DB: refrescar para
      // que la próxima renderice el estado estable `Omitido por juez` en vez
      // de re-ofrecer `Redactar` hasta la próxima navegación.
      if (isJudgeVetoMessage(r.message)) router.refresh();
    } finally {
      setBusyIds((prev) => prev.filter((id) => id !== row.signalId));
    }
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-11 px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Customer
            </TableHead>
            <TableHead className="h-11 px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Motivo
            </TableHead>
            <TableHead className="h-11 w-24 px-4 text-right text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Action
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const tier = tierOf(row);
            const pred = row.decision === "actuar" || row.decision === "revision_humana"
              ? row
              : null;
            const chip = row.decision === "revision_humana"
              ? "Revisar 1 a 1"
              : pred
                ? "Para actuar"
                : null;
            const ventana =
              pred && row.tDays !== null && row.tDays !== undefined && row.p25Days != null && row.p75Days != null
                ? `lleva ${formatNumber(row.tDays)}d · suele volver ${formatNumber(row.p25Days)}–${formatNumber(row.p75Days)}d` +
                  (row.tDays > row.p75Days
                    ? ` (+${formatNumber(row.tDays - row.p75Days)}d de su ventana)`
                    : row.tDays < row.p25Days
                      ? ` (entra en ~${formatNumber(Math.max(0, Math.ceil(row.p25Days - row.tDays)))}d)`
                      : "")
                : null;
            const frecuencia =
              pred && row.pRecompraH != null
                ? `de cada 10 similares, ~${formatNumber(row.pRecompraH * 10)} vuelven sin escribir` +
                  (row.confidence === "baja" ? " (estimación inicial)" : "")
                : null;
            const ticket =
              pred && row.ticketEsperadoMinor != null
                ? `ticket esp. ${formatMoney(row.ticketEsperadoMinor, row.predCurrency ?? currency)} · sin descuento`
                : null;
            return (
            <TableRow
              key={row.signalId}
              onClick={() => void open(row)}
              className="cursor-pointer"
            >
              <TableCell className="px-4 py-3.5 font-medium">
                {loadingId === row.customerDbId ? "Cargando…" : row.name}
                <span className="block text-xs font-normal text-muted-foreground">
                  {row.email}{" "}
                  {chip ? (
                    <span className="font-medium text-foreground">· {chip}</span>
                  ) : (
                    <>
                      ·{" "}
                      <span className={tier.hot ? "font-medium text-destructive" : undefined}>
                        {tier.text}
                      </span>
                    </>
                  )}{" "}
                  {ticket ?? `· ticket ~${formatMoney(Math.round(row.totalSpent / Math.max(1, row.ordersCount)), currency)}`}
                </span>
                {ventana && (
                  <span className="block text-xs font-normal text-muted-foreground tabular-nums">
                    {ventana}
                  </span>
                )}
                {frecuencia && (
                  <span className="block text-xs font-normal text-muted-foreground tabular-nums">
                    {frecuencia}
                  </span>
                )}
              </TableCell>
              <TableCell className="px-4 py-3.5 text-muted-foreground">
                {row.reason ?? row.kind}
              </TableCell>
              <TableCell className="px-4 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                {row.draftStatus === "pending" ? (
                  <Button render={<Link href="/review" />} nativeButton={false} variant="outline" size="sm">
                    Revisar
                  </Button>
                ) : row.draftStatus === "approved" ? (
                  <span className="text-xs text-muted-foreground">Aprobado</span>
                ) : row.draftStatus === "dispatched" ? (
                  <span className="text-xs text-muted-foreground">Enviado ✓</span>
                ) : row.contactability?.eligible === false ? (
                  <AppTooltip tip={row.contactability.reason ?? "Omitido por el juez"}>
                    <span className="inline-flex flex-col items-end gap-1">
                      {/* El Button deshabilitado lleva `pointer-events-none`: el
                          trigger es el wrapper, no el botón. */}
                      <Button variant="outline" size="sm" disabled>
                        Omitido por juez ⓘ
                      </Button>
                      <span className="max-w-44 text-xs text-muted-foreground">
                        {row.contactability.reason ?? "Sin contenido vigente para invitarle hoy."}
                      </span>
                    </span>
                  </AppTooltip>
                ) : (
                  <span className="inline-flex flex-col items-end gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyIds.includes(row.signalId)}
                      onClick={() => void redact(row)}
                    >
                      {busyIds.includes(row.signalId) ? "Redactando…" : "Redactar"}
                    </Button>
                    {draftError?.id === row.signalId && (
                      <AppTooltip tip={draftError.message}>
                        <span className="max-w-44 text-xs text-destructive">
                          {draftError.message}
                        </span>
                      </AppTooltip>
                    )}
                  </span>
                )}
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {selected && (
        <CustomerDrawer
          key={selected.dbId}
          customer={selected}
          initialTab="compras"
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

/** Estado vacío de la mira (Fase 4): SSR inicial + vivo del contexto. Sin
 *  realtime, una corrida que arranca tras el primer render mostraría un
 *  vacío engañoso en vez del skeleton. */
function AttentionEmptyState({
  initialRunning,
  pending,
  masivos,
  reviewHref,
}: {
  initialRunning: boolean;
  pending: number;
  masivos: number;
  reviewHref: string;
}) {
  const bg = useBackgroundOrNull();
  const liveRunning =
    initialRunning || (bg?.activeRuns.some((r) => r.kind === "scout" || r.kind === "strategist") ?? false);
  if (liveRunning) {
    return (
      <div className="p-4">
        <SectionLoading label="clientes en la mira" rows={2} />
      </div>
    );
  }
  if (pending > 0) {
    return (
      <p className="p-4 text-[13px] text-muted-foreground">
        Los de hoy ya están listos en{" "}
        <Link href={reviewHref} className="underline">
          Review
        </Link>
        .
      </p>
    );
  }
  if (masivos > 0) {
    return (
      <p className="p-4 text-[13px] text-muted-foreground">
        Tu mira son solo inactivos antiguos: van con reactivación masiva,
        no 1-a-1.
      </p>
    );
  }
  return (
    <p className="p-4 text-[13px] text-muted-foreground">
      Todo al día — ningún cliente vencido. Tu equipo IA sigue vigilando.
    </p>
  );
}
