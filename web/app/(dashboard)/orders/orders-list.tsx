"use client";

import { useCallback, useMemo, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Radio, TriangleAlert, Camera, Wallet } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { SectionHeading } from "@/components/section-heading";
import { Metric, MetricRow } from "@/components/metric";
import { ClearFiltersButton } from "@/components/buttons";
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
import { ORDER_STAGE_LABELS, ORDER_STAGES as STAGES } from "@/lib/order-stage";
import type { OrderStageKey } from "@/lib/order-stage";
import { BILLING_LABELS } from "@/lib/billing-status";
import type { BillingStatusKey } from "@/lib/billing-status";
import { OrderAutorizadaBadge, OrderBillingBadge, OrderStageBadge } from "@/components/order-badges";
import { Money } from "@/components/money";
import { normalizeCurrency } from "@/lib/currency";
import { formatMoney, formatNumber } from "@/lib/format";
import type { OrderRow } from "@/lib/orders-db";
import type { MemberRole } from "@/lib/roles";
import { OrdenDrawer } from "./orden-drawer";
import { EntityCount, EntityEmpty, useEntitySelection } from "@/components/entity-list";
import { ExportCsvButton } from "@/components/export-csv-button";

function fmtCorto(v: string | null): string {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

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
  // Selección con deep-link (?order=, alias ?orden=). Ver entity-list.tsx.
  const { selectedId, open: openDrawer, close: closeDrawer } = useEntitySelection(
    "/orders",
    "order",
    initialSelectedId,
    ["orden"],
  );
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Prefetch del detalle al hover/foco: calienta la compilación de la ruta
  // + DB antes de abrir (el drawer usa no-store, esto no sustituye su fetch;
  // recorta el costo frío medido en el análisis perf 2026-11-09).
  const prefetched = useRef(new Set<string>());
  const prefetchOrder = useCallback((id: string) => {
    if (prefetched.current.has(id)) return;
    prefetched.current.add(id);
    void fetch(`/api/orders/${id}`).catch(() => {});
  }, []);

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
    const brutoBy = new Map<string, number>();
    const vencidoBy = new Map<string, number>();
    let alAire = 0;
    let porCertificar = 0;
    let vencidas = 0;
    for (const o of rows) {
      const cur = normalizeCurrency(o.currency, "PEN");
      brutoBy.set(cur, (brutoBy.get(cur) ?? 0) + (Number(o.gross_minor ?? 0) || 0));
      if (o.stage === "al_aire") alAire += 1;
      if (o.stage === "por_certificar") porCertificar += 1;
      if (o.billing === "vencido") {
        vencidas += 1;
        vencidoBy.set(cur, (vencidoBy.get(cur) ?? 0) + (Number(o.pending_minor ?? 0) || 0));
      }
    }
    const fmtGrouped = (m: Map<string, number>) => {
      const parts = [...m.entries()].filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b));
      if (parts.length === 0) return "—";
      return parts.map(([c, v]) => formatMoney(v, c)).join(" + ");
    };
    return { brutoBy, vencidoBy, brutoLabel: fmtGrouped(brutoBy), vencidoLabel: fmtGrouped(vencidoBy), alAire, porCertificar, vencidas };
  }, [rows]);

  const hasFilter = q.trim() !== "" || stage !== null || billing !== null;
  const exportParams = new URLSearchParams({ entity: "orders" });
  if (q.trim()) exportParams.set("q", q.trim());
  if (stage) exportParams.set("stage", stage);
  if (billing) exportParams.set("billing", billing);

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Resumen · órdenes visibles">
        <SectionHeading title="Resumen" hint="Acumulado de la tabla con los filtros actuales." tone="emerald" />
        <MetricRow columns={4}>
          <Metric label="Bruto listado" icon={Wallet} value={summary.brutoLabel} hint="Contratado en las órdenes visibles" />
          <Metric label="Al aire" icon={Radio} value={formatNumber(summary.alAire)} hint="Órdenes pautando hoy" />
          <Metric
            label="Por certificar"
            icon={Camera}
            value={formatNumber(summary.porCertificar)}
            hint="Terminadas sin evidencia"
            tone={summary.porCertificar > 0 ? "warning" : "default"}
          />
          <Metric
            label="Vencido"
            icon={TriangleAlert}
            value={formatNumber(summary.vencidas)}
            hint={summary.vencidas > 0 ? `${summary.vencidoLabel} pendiente de cobro` : "Sin cobros vencidos"}
            tone={summary.vencidas > 0 ? "danger" : "default"}
          />
        </MetricRow>
      </section>

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
          <ClearFiltersButton disabled={isPending} onClear={() => go({ q: "", stage: null, billing: null })} />
        )}
        <ExportCsvButton href={`/api/export?${exportParams.toString()}`} label="Exportar órdenes filtradas a CSV" />
        <EntityCount total={rows.length} pending={isPending} />
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
                onClick={() => openDrawer(o.id)}
                onMouseEnter={() => prefetchOrder(o.id)}
                onFocus={() => prefetchOrder(o.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openDrawer(o.id);
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
                  {o.gross_minor > 0 ? <Money amountMinor={o.gross_minor} currency={o.currency} /> : "—"}
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
                        <Money amountMinor={o.pending_minor} currency={o.currency} /> pend.
                      </span>
                    )}
                    {o.billing === "vencido" && o.pending_minor > 0 && (
                      <span className="text-[11px] font-medium text-destructive tabular-nums">
                        <Money amountMinor={o.pending_minor} currency={o.currency} /> pend.
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
                <DataTableTd colSpan={7} className="px-3 py-4">
                  <EntityEmpty
                    inline
                    filtered={hasFilter}
                    emptyTitle="Aún no hay órdenes"
                    emptyHint="Crea la primera orden para empezar el flujo: firma, al aire y cobro."
                    onClear={hasFilter ? () => go({ q: "", stage: null, billing: null }) : undefined}
                  />
                </DataTableTd>
              </DataTableRow>
            )}
          </DataTableBody>
        </DataTable>
      </AppCard>

      {selectedId && <OrdenDrawer key={selectedId} orderId={selectedId} myRole={myRole} onClose={closeDrawer} />}
    </div>
  );
}
