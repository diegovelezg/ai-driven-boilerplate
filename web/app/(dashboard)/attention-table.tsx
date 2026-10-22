"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { toast } from "@/components/ui/toast";
import { proposeSingleAction } from "@/lib/review-actions";
import { useBackground } from "@/components/background-status";
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableRow,
  DataTableTd,
  DataTableTh,
} from "@/components/data-table";
import type { EditableCustomer } from "@/lib/customers-db";
import { formatMoney, formatNumber } from "@/lib/format";
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
      if (!res.ok) {
        toast.add({
          title: "No se pudo abrir la ficha",
          description: `La ficha respondió ${res.status}.`,
          type: "error",
        });
        return;
      }
      const j = (await res.json()) as { customer?: EditableCustomer };
      if (j.customer) setSelected(j.customer);
    } catch (e) {
      toast.add({
        title: "No se pudo abrir la ficha",
        description: e instanceof Error ? e.message : "Error inesperado.",
        type: "error",
      });
    } finally {
      setLoadingId(null);
    }
  };

  const redact = async (row: AttentionItem) => {
    if (busyIds.includes(row.signalId)) return;
    setBusyIds((prev) => [...prev, row.signalId]);
    try {
      // Por `useBackground().start`: el intento suma a la cinta global.
      // Con run la cinta avisa; sin run (veto/duplicado rápido) avisar aquí.
      const r = await start(async () => {
        const x = await proposeSingleAction(row.signalId);
        return { ok: x.ok, message: x.message, run: x.run ?? null };
      });
      if (!r.run) {
        toast.add({
          title: r.ok ? "Borrador redactado" : "No se pudo redactar",
          description: r.message,
          type: r.ok ? "success" : "error",
        });
      }
      // El veto escribe `evidence_json.contactability` en DB: el refresh ya
      // lo hizo `start()`; sin doble refresh no se aborta el RSC en vuelo
      // (ECONNRESET + parpadeo).
    } catch (e) {
      // Sin corrida no hay cinta que avise: solo la excepción va a toast.
      toast.add({
        title: "No se pudo redactar",
        description: e instanceof Error ? e.message : "Error inesperado.",
        type: "error",
      });
    } finally {
      setBusyIds((prev) => prev.filter((id) => id !== row.signalId));
    }
  };

  return (
    <>
      <DataTable>
        <DataTableHeader>
          <DataTableTh>
            Customer
          </DataTableTh>
          <DataTableTh>
            Motivo
          </DataTableTh>
          <DataTableTh numeric className="w-24">
            Action
          </DataTableTh>
        </DataTableHeader>
        <DataTableBody>
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
            <DataTableRow
              key={row.signalId}
              onClick={() => void open(row)}
              className="cursor-pointer"
            >
              <DataTableTd className="font-medium">
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
              </DataTableTd>
              <DataTableTd className="text-muted-foreground">
                {row.reason ?? row.kind}
              </DataTableTd>
              <DataTableTd numeric onClick={(e) => e.stopPropagation()}>
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
                  </span>
                )}
              </DataTableTd>
            </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>
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
