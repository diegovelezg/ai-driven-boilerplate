"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AppCard } from "@/components/app-card";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableRow,
  DataTableTd,
  DataTableTh,
  SortHeaderButton,
} from "@/components/data-table";
import { FilterSearch } from "@/components/filter-search";
import { formatMoney, formatNumber } from "@/lib/format";
import type { BrandsSortDir, BrandsSortKey, BrandRow } from "@/lib/brand-db";
import { MarcaDrawer } from "./marca-drawer";

export function BrandsList({
  rows,
  q,
  sortKey,
  sortDir,
}: {
  rows: BrandRow[];
  q: string;
  sortKey: BrandsSortKey;
  sortDir: BrandsSortDir;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedBrand, setSelectedBrand] = useState<string | null>(null);

  const buildParams = useCallback(
    (overrides: { q?: string; sort?: string; dir?: string }) => {
      const params = new URLSearchParams();
      const nextQ = overrides.q ?? q;
      if (nextQ.trim()) params.set("q", nextQ.trim());
      params.set("sort", overrides.sort ?? sortKey);
      params.set("dir", overrides.dir ?? sortDir);
      return params.toString();
    },
    [q, sortKey, sortDir],
  );

  // Todo calculado en servidor sobre todas las IOs (ver lib/brand-db).
  // Texto ASC primero; métricas DESC primero (lo más relevante).
  const toggleSort = (key: BrandsSortKey) => {
    let nextDir: BrandsSortDir;
    if (key === sortKey) {
      nextDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      nextDir = key === "brand" ? "asc" : "desc";
    }
    startTransition(() => {
      router.replace(`/brands?${buildParams({ sort: key, dir: nextDir })}`);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar por marca, agencia o pantalla…"
          ariaLabel="Buscar marcas"
          onSearch={(value) => {
            startTransition(() => {
              router.replace(`/brands?${buildParams({ q: value })}`);
            });
          }}
        />
        {q.trim() !== "" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => {
              startTransition(() => {
                router.replace(`/brands?${buildParams({ q: "" })}`);
              });
            }}
          >
            Limpiar
          </Button>
        )}
        <span className="ms-auto text-xs text-muted-foreground tabular-nums">
          {isPending ? "Buscando…" : `${formatNumber(rows.length)} marca${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <AppCard variant="table">
        <DataTable>
          <DataTableHeader>
            <DataTableTh aria-sort={sortKey === "brand" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "brand"} dir={sortDir} onClick={() => toggleSort("brand")} ariaLabel="Ordenar por marca">
                Marca
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh aria-sort="none">Estado</DataTableTh>
            <DataTableTh numeric aria-sort={sortKey === "ios" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "ios"} dir={sortDir} alignRight onClick={() => toggleSort("ios")} ariaLabel="Ordenar por pedidos">
                Pedidos
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh numeric aria-sort={sortKey === "investment" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "investment"} dir={sortDir} alignRight onClick={() => toggleSort("investment")} ariaLabel="Ordenar por inversión">
                Inversión
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh aria-sort={sortKey === "last" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "last"} dir={sortDir} onClick={() => toggleSort("last")} ariaLabel="Ordenar por última pauta">
                Última pauta
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh numeric aria-sort={sortKey === "screens" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "screens"} dir={sortDir} alignRight onClick={() => toggleSort("screens")} ariaLabel="Ordenar por pantallas">
                Pantallas
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh aria-sort={sortKey === "agencies" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "agencies"} dir={sortDir} onClick={() => toggleSort("agencies")} ariaLabel="Ordenar por agencias">
                Agencias
              </SortHeaderButton>
            </DataTableTh>
          </DataTableHeader>
          <DataTableBody>
            {rows.map((r) => (
              <DataTableRow
                key={r.brand}
                tabIndex={0}
                role="button"
                aria-label={`Abrir marca ${r.brand}`}
                onClick={() => setSelectedBrand(r.brand)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedBrand(r.brand);
                  }
                }}
                className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <DataTableTd className="max-w-[220px] truncate px-3 py-4 font-medium">{r.brand}</DataTableTd>
                <DataTableTd className="px-3 py-4">
                  <span
                    className={
                      r.active
                        ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"
                        : "rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                    }
                  >
                    {r.active ? "En pauta" : "Sin pauta"}
                  </span>
                </DataTableTd>
                <DataTableTd numeric className="px-3 py-4 tabular-nums">
                  {formatNumber(r.ios)}
                </DataTableTd>
                <DataTableTd numeric className="px-3 py-4 tabular-nums">
                  {formatMoney(r.total_minor, "PEN")}
                </DataTableTd>
                <DataTableTd className="px-3 py-4 text-[13px] text-muted-foreground tabular-nums">
                  {r.last_end ?? <span className="text-muted-foreground/60">—</span>}
                </DataTableTd>
                <DataTableTd numeric className="px-3 py-4 tabular-nums">
                  <AppTooltip tip={r.screens.join(", ") || "Sin pantallas"}>
                    <span>{formatNumber(r.screens.length)}</span>
                  </AppTooltip>
                </DataTableTd>
                <DataTableTd className="max-w-[220px] truncate px-3 py-4 text-[13px] text-muted-foreground">
                  {r.agencies.length > 0 ? (
                    <AppTooltip tip={r.agencies.join(", ")}>
                      <span>{r.agencies.join(" · ")}</span>
                    </AppTooltip>
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </DataTableTd>
              </DataTableRow>
            ))}
            {rows.length === 0 && (
              <DataTableRow>
                <DataTableTd colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  {q ? `Sin resultados para “${q}”.` : "Sin marcas: las marcas nacen de los pedidos."}
                </DataTableTd>
              </DataTableRow>
            )}
          </DataTableBody>
        </DataTable>
      </AppCard>

      {selectedBrand && <MarcaDrawer key={selectedBrand} brandName={selectedBrand} onClose={() => setSelectedBrand(null)} />}
    </div>
  );
}
