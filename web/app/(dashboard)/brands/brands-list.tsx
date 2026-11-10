"use client";

import { useCallback, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilterX } from "lucide-react";
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
import { BrandPautaBadge } from "@/components/badges";
import { formatMoney, formatNumber } from "@/lib/format";
import type { BrandsSortDir, BrandsSortKey, BrandRow } from "@/lib/brand-db";
import { MarcaDrawer } from "./marca-drawer";
import { EntityCount, EntityEmpty, useEntitySelection } from "@/components/entity-list";
import { ExportCsvButton } from "@/components/export-csv-button";

export function BrandsList({
  rows,
  q,
  sortKey,
  sortDir,
  initialSelectedBrand = null,
}: {
  rows: BrandRow[];
  q: string;
  sortKey: BrandsSortKey;
  sortDir: BrandsSortDir;
  initialSelectedBrand?: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Prefetch del detalle al hover/foco (mismo patrón que orders-list).
  const prefetched = useRef(new Set<string>());
  const prefetchBrand = useCallback((brand: string) => {
    if (prefetched.current.has(brand)) return;
    prefetched.current.add(brand);
    void fetch(`/api/brands/${encodeURIComponent(brand)}`).catch(() => {});
  }, []);
  // Selección con deep-link (?brand=, alias ?marca=). Ver entity-list.tsx.
  const { selectedId: selectedBrand, open: openDrawer, close: closeDrawer } = useEntitySelection(
    "/brands",
    "brand",
    initialSelectedBrand ?? null,
    ["marca"],
  );

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

  const exportParams = new URLSearchParams({ entity: "brands" });
  if (q.trim()) exportParams.set("q", q.trim());
  exportParams.set("sort", sortKey);
  exportParams.set("dir", sortDir);

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
            <FilterX aria-hidden />
            Limpiar
          </Button>
        )}
        <ExportCsvButton href={`/api/export?${exportParams.toString()}`} label="Exportar marcas filtradas a CSV" />
        <EntityCount total={rows.length} pending={isPending} singular="marca" plural="marcas" />
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
                onClick={() => openDrawer(r.brand)}
                onMouseEnter={() => prefetchBrand(r.brand)}
                onFocus={() => prefetchBrand(r.brand)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openDrawer(r.brand);
                  }
                }}
                className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <DataTableTd className="max-w-[220px] truncate px-3 py-4 font-medium">{r.brand}</DataTableTd>
                <DataTableTd className="px-3 py-4">
                  <BrandPautaBadge active={r.active} />
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
                <DataTableTd colSpan={7} className="px-3 py-4">
                  <EntityEmpty
                    inline
                    filtered={q.trim() !== ""}
                    emptyTitle="Sin marcas"
                    emptyHint="Las marcas nacen de los pedidos."
                    onClear={() => {
                      startTransition(() => {
                        router.replace(`/brands?${buildParams({ q: "" })}`);
                      });
                    }}
                  />
                </DataTableTd>
              </DataTableRow>
            )}
          </DataTableBody>
        </DataTable>
      </AppCard>

      {selectedBrand && <MarcaDrawer key={selectedBrand} brandName={selectedBrand} onClose={closeDrawer} />}
    </div>
  );
}
