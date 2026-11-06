"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableRow,
  DataTableTd,
  DataTableTh,
} from "@/components/data-table";
import { FilterSearch } from "@/components/filter-search";
import { FilterSelect, SelectItem } from "@/components/filter-select";
import { ORDER_STAGE_LABELS } from "@/lib/order-stage";
import type { OrderStageKey } from "@/lib/order-stage";
import { formatMoney, formatNumber } from "@/lib/format";
import type { OrderRow } from "@/lib/orders-db";
import { OrdenDrawer } from "./orden-drawer";

const STAGES = Object.keys(ORDER_STAGE_LABELS) as OrderStageKey[];

export function OrdenesList({
  rows,
  q,
  stage,
  initialSelectedId,
}: {
  rows: OrderRow[];
  q: string;
  stage: OrderStageKey | null;
  initialSelectedId: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const go = (patch: { q?: string; etapa?: string | null }) => {
    const params = new URLSearchParams();
    const nextQ = patch.q ?? q;
    if (nextQ.trim()) params.set("q", nextQ.trim());
    const nextStage = patch.etapa !== undefined ? patch.etapa : stage;
    if (nextStage) params.set("etapa", nextStage);
    startTransition(() => {
      router.replace(`/ordenes?${params.toString()}`);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar por IO o marca…"
          ariaLabel="Buscar órdenes"
          onSearch={(value) => go({ q: value })}
        />
        <FilterSelect
          value={stage ?? "all"}
          onChange={(v) => go({ etapa: v === "all" ? null : v })}
          ariaLabel="Filtrar por etapa"
          placeholder="Etapa"
          display={(value) => (value === "all" ? "Toda etapa" : (ORDER_STAGE_LABELS[value as OrderStageKey] ?? value))}
        >
          <SelectItem value="all">Toda etapa</SelectItem>
          {STAGES.map((s) => (
            <SelectItem key={s} value={s}>
              {ORDER_STAGE_LABELS[s]}
            </SelectItem>
          ))}
        </FilterSelect>
        {(q.trim() !== "" || stage !== null) && (
          <Button variant="ghost" size="sm" disabled={isPending} onClick={() => go({ q: "", etapa: null })}>
            Limpiar
          </Button>
        )}
        <span className="ms-auto text-xs text-muted-foreground tabular-nums">
          {isPending ? "Buscando…" : `${formatNumber(rows.length)} resultado${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <AppCard variant="table">
        <DataTable>
          <DataTableHeader>
            <DataTableTh>Orden</DataTableTh>
            <DataTableTh>Marca</DataTableTh>
            <DataTableTh>Cliente</DataTableTh>
            <DataTableTh>Periodo</DataTableTh>
            <DataTableTh numeric>Bruto</DataTableTh>
            <DataTableTh>Etapa</DataTableTh>
          </DataTableHeader>
          <DataTableBody>
            {rows.map((o) => (
              <DataTableRow key={o.id} onClick={() => setSelectedId(o.id)} className="cursor-pointer">
                <DataTableTd className="font-medium">{o.io_number}</DataTableTd>
                <DataTableTd className="text-[13px]">{o.brand ?? "—"}</DataTableTd>
                <DataTableTd className="max-w-[220px] truncate text-[13px] text-muted-foreground">
                  {o.billing_name ?? o.advertiser_name ?? "—"}
                </DataTableTd>
                <DataTableTd className="text-[13px] text-muted-foreground tabular-nums">
                  {o.starts_at && o.ends_at ? `${o.starts_at} → ${o.ends_at}` : "—"}
                </DataTableTd>
                <DataTableTd numeric className="tabular-nums">
                  {o.gross_minor > 0 ? formatMoney(o.gross_minor, "PEN") : "—"}
                </DataTableTd>
                <DataTableTd>
                  <Badge variant="secondary" className="font-normal">
                    {ORDER_STAGE_LABELS[o.stage]}
                  </Badge>
                </DataTableTd>
              </DataTableRow>
            ))}
            {rows.length === 0 && (
              <DataTableRow>
                <DataTableTd colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  {q || stage ? "Sin resultados para ese filtro." : "Aún no hay órdenes."}
                </DataTableTd>
              </DataTableRow>
            )}
          </DataTableBody>
        </DataTable>
      </AppCard>

      {selectedId && <OrdenDrawer orderId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
