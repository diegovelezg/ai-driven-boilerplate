"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SearchX } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
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
import { BILLING_LABELS } from "@/lib/billing-status";
import type { BillingStatusKey } from "@/lib/billing-status";
import { OrderAutorizadaBadge, OrderBillingBadge, OrderStageBadge } from "@/components/order-badges";
import { formatMoney, formatNumber } from "@/lib/format";
import type { OrderRow } from "@/lib/orders-db";
import type { MemberRole } from "@/lib/roles";
import { OrdenDrawer } from "./orden-drawer";

function fmtCorto(v: string | null): string {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

const STAGES: OrderStageKey[] = ["firmada", "materiales", "al_aire", "por_certificar", "cerrada", "cancelada"];
const BILLINGS: BillingStatusKey[] = ["sin_facturar", "facturado", "parcial", "pagado", "vencido"];

export function OrdersList({
  rows,
  q,
  stage,
  billing,
  initialSelectedId,
  myRole,
}: {
  rows: OrderRow[];
  q: string;
  stage: OrderStageKey | null;
  billing: BillingStatusKey | null;
  initialSelectedId: string | null;
  myRole: MemberRole | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const go = (patch: { q?: string; stage?: string | null; billing?: string | null }) => {
    const params = new URLSearchParams();
    const nextQ = patch.q ?? q;
    if (nextQ.trim()) params.set("q", nextQ.trim());
    const nextStage = patch.stage !== undefined ? patch.stage : stage;
    if (nextStage) params.set("stage", nextStage);
    const nextBilling = patch.billing !== undefined ? patch.billing : billing;
    if (nextBilling) params.set("billing", nextBilling);
    startTransition(() => {
      router.replace(`/orders?${params.toString()}`);
    });
  };

  const summary = useMemo(() => {
    let bruto = 0;
    let alAire = 0;
    let porCertificar = 0;
    let vencidas = 0;
    let vencidoMonto = 0;
    for (const o of rows) {
      bruto += Number(o.gross_minor ?? 0) || 0;
      if (o.stage === "al_aire") alAire += 1;
      if (o.stage === "por_certificar") porCertificar += 1;
      if (o.billing === "vencido") {
        vencidas += 1;
        vencidoMonto += Number(o.pending_minor ?? 0) || 0;
      }
    }
    return { bruto, alAire, porCertificar, vencidas, vencidoMonto };
  }, [rows]);

  const hasFilter = q.trim() !== "" || stage !== null || billing !== null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4" aria-label="Resumen">
        <div className="rounded-xl border bg-card px-3.5 py-3">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Bruto listado</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{summary.bruto > 0 ? formatMoney(summary.bruto, "PEN") : "—"}</p>
        </div>
        <div className="rounded-xl border bg-card px-3.5 py-3">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Al aire</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(summary.alAire)}</p>
        </div>
        <div className="rounded-xl border bg-card px-3.5 py-3">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Por certificar</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(summary.porCertificar)}</p>
        </div>
        <div className="rounded-xl border bg-card px-3.5 py-3">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Vencido</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {formatNumber(summary.vencidas)}
            {summary.vencidoMonto > 0 && (
              <span className="ml-2 align-middle text-xs font-medium text-destructive">
                {formatMoney(summary.vencidoMonto, "PEN")} pend.
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5" role="search" aria-label="Filtros de órdenes">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar IO, marca o empresa…"
          ariaLabel="Buscar órdenes"
          onSearch={(value) => go({ q: value })}
        />
        <FilterSelect
          value={stage ?? "all"}
          onChange={(v) => go({ stage: v === "all" ? null : v })}
          ariaLabel="Filtrar por etapa operativa"
          placeholder="Etapa"
          display={(value) => (value === "all" ? "Etapa: todas" : `Etapa: ${ORDER_STAGE_LABELS[value as OrderStageKey] ?? value}`)}
        >
          <SelectItem value="all">Toda etapa</SelectItem>
          {STAGES.map((s) => (
            <SelectItem key={s} value={s}>
              {ORDER_STAGE_LABELS[s]}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect
          value={billing ?? "all"}
          onChange={(v) => go({ billing: v === "all" ? null : v })}
          ariaLabel="Filtrar por estado de cobro"
          placeholder="Cobro"
          display={(value) => (value === "all" ? "Cobro: todo" : `Cobro: ${BILLING_LABELS[value as BillingStatusKey] ?? value}`)}
        >
          <SelectItem value="all">Todo cobro</SelectItem>
          {BILLINGS.map((s) => (
            <SelectItem key={s} value={s}>
              {BILLING_LABELS[s]}
            </SelectItem>
          ))}
        </FilterSelect>
        {hasFilter && (
          <Button variant="ghost" size="sm" disabled={isPending} onClick={() => go({ q: "", stage: null, billing: null })}>
            Limpiar
          </Button>
        )}
        <span className="ms-auto text-xs text-muted-foreground tabular-nums" aria-live="polite">
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
            <DataTableTh>Cobro</DataTableTh>
          </DataTableHeader>
          <DataTableBody>
            {rows.map((o) => (
              <DataTableRow
                key={o.id}
                tabIndex={0}
                role="button"
                aria-label={`Abrir orden ${o.io_number}`}
                onClick={() => setSelectedId(o.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedId(o.id);
                  }
                }}
                className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <DataTableTd className="font-medium">{o.io_number}</DataTableTd>
                <DataTableTd className="text-[13px]">{o.brand ?? "—"}</DataTableTd>
                <DataTableTd
                  className="max-w-[220px] truncate text-[13px] text-muted-foreground"
                  title={o.billing_name ?? o.advertiser_name ?? undefined}
                >
                  {o.billing_name ?? o.advertiser_name ?? "—"}
                </DataTableTd>
                <DataTableTd className="text-[13px] whitespace-nowrap text-muted-foreground tabular-nums">
                  {o.starts_at && o.ends_at ? `${fmtCorto(o.starts_at)} → ${fmtCorto(o.ends_at)}` : "—"}
                </DataTableTd>
                <DataTableTd numeric className="font-medium tabular-nums">
                  {o.gross_minor > 0 ? formatMoney(o.gross_minor, "PEN") : "—"}
                </DataTableTd>
                <DataTableTd>
                  <span className="flex flex-col items-start gap-1">
                    <OrderStageBadge stage={o.stage} isDraft={o.status === "draft"} />
                    {o.has_om && o.stage !== "cancelada" && <OrderAutorizadaBadge />}
                  </span>
                </DataTableTd>
                <DataTableTd>
                  <span className="flex flex-col items-start gap-1">
                    <OrderBillingBadge status={o.billing} />
                    {o.billing === "parcial" && o.pending_minor > 0 && (
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {formatMoney(o.pending_minor, "PEN")} pend.
                      </span>
                    )}
                    {o.billing === "vencido" && o.pending_minor > 0 && (
                      <span className="text-[11px] font-medium text-destructive tabular-nums">
                        {formatMoney(o.pending_minor, "PEN")} pend.
                      </span>
                    )}
                    {o.billing === "pagado" && o.isPrepaid && (
                      <span className="text-[11px] text-muted-foreground">prepago</span>
                    )}
                  </span>
                </DataTableTd>
              </DataTableRow>
            ))}
            {rows.length === 0 && (
              <DataTableRow>
                <DataTableTd colSpan={7} className="px-3 py-10">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-2 text-center">
                    <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden>
                      <SearchX className="size-5" />
                    </span>
                    <p className="text-sm font-medium">
                      {hasFilter ? "Sin resultados para ese filtro" : "Aún no hay órdenes"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {hasFilter
                        ? "Prueba con otro IO, marca o combina etapa y cobro."
                        : "Crea la primera OI para empezar el flujo Firmada → Al aire → Cobro."}
                    </p>
                    {hasFilter && (
                      <Button variant="outline" size="sm" className="mt-1" onClick={() => go({ q: "", stage: null, billing: null })}>
                        Limpiar filtros
                      </Button>
                    )}
                  </div>
                </DataTableTd>
              </DataTableRow>
            )}
          </DataTableBody>
        </DataTable>
      </AppCard>

      {selectedId && <OrdenDrawer orderId={selectedId} myRole={myRole} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
