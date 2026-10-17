"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { proposeSingleAction } from "@/lib/review-actions";
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
import { CustomerDrawer } from "./customers/customer-drawer";

export interface AttentionItem {
  signalId: string;
  customerDbId: string;
  kind: string;
  score: number | null;
  reason: string | null;
  /** Días sin comprar (null = otros tipos de señal). Para el ranking por valor. */
  daysSince: number | null;
  /** Segmento RFM e insignia "No los pierdas" (tratamiento, no segmento). */
  segment: string;
  noLosPierdas: boolean;
  /** Último borrador de la señal (define el CTA: Redactar/Revisar/estado). */
  draftStatus: "none" | "pending" | "approved" | "dispatched";
  email: string;
  name: string;
  ordersCount: number;
  totalSpent: number;
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
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [draftErrorId, setDraftErrorId] = useState<string | null>(null);
  const router = useRouter();

  // La fila habla tratamiento (qué hago), no identidad (el segmento vive en la
  // ficha y los filtros). Mismo idioma que el briefing: 3 tiers excluyentes.
  const tierOf = (row: AttentionItem): { text: string; hot: boolean } => {
    if (row.noLosPierdas) return { text: "No los pierdas", hot: true };
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
    if (draftingId) return;
    setDraftingId(row.signalId);
    setDraftErrorId(null);
    try {
      const r = await proposeSingleAction(row.signalId);
      if (r.ok) router.refresh();
      else setDraftErrorId(row.signalId);
    } finally {
      setDraftingId(null);
    }
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Motivo</TableHead>
            <TableHead className="w-24 text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const tier = tierOf(row);
            return (
            <TableRow
              key={row.signalId}
              onClick={() => void open(row)}
              className="cursor-pointer"
            >
              <TableCell className="font-medium">
                {loadingId === row.customerDbId ? "Cargando…" : row.name}
                <span className="block text-xs font-normal text-muted-foreground">
                  {row.email} ·{" "}
                  <span className={tier.hot ? "font-medium text-destructive" : undefined}>
                    {tier.text}
                  </span>{" "}
                  · ticket ~{formatMoney(Math.round(row.totalSpent / Math.max(1, row.ordersCount)), currency)}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.reason ?? row.kind}
              </TableCell>
              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                {row.draftStatus === "pending" ? (
                  <Button render={<Link href="/review" />} nativeButton={false} variant="outline" size="sm">
                    Revisar
                  </Button>
                ) : row.draftStatus === "approved" ? (
                  <span className="text-xs text-muted-foreground">Aprobado</span>
                ) : row.draftStatus === "dispatched" ? (
                  <span className="text-xs text-muted-foreground">Enviado ✓</span>
                ) : (
                  <span className="inline-flex flex-col items-end gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={draftingId !== null}
                      onClick={() => void redact(row)}
                    >
                      {draftingId === row.signalId ? "Redactando…" : "Redactar"}
                    </Button>
                    {draftErrorId === row.signalId && (
                      <span className="text-xs text-destructive">No se pudo redactar</span>
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
