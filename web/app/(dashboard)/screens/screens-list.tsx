"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilterX, LayoutGrid, List as ListIcon, SearchX } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { Button } from "@/components/ui/button";
import { PantallaDrawer } from "./pantalla-drawer";
import { EntityCount, EntityEmpty, EntityPagination, useEntitySelection } from "@/components/entity-list";
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
import { FilterSelect, SelectItem } from "@/components/filter-select";
import { Badge } from "@/components/ui/badge";
import { formatDecimal, formatNumber, toTitleCase } from "@/lib/format";
import { cn } from "cn";
import type { ScreenListRow, ScreensSortDir, ScreensSortKey } from "@/lib/screens-db";

function fmtMedidas(s: ScreenListRow): string {
  if (s.width_m !== null && s.height_m !== null) return `${formatDecimal(s.width_m, 2)}×${formatDecimal(s.height_m, 2)} m`;
  if (s.width_px !== null && s.height_px !== null) return `${formatNumber(s.width_px)}×${formatNumber(s.height_px)} px`;
  return "—";
}

export function ScreensList({
  rows,
  totalCount,
  page,
  pageSize,
  q,
  supplierId,
  suppliers,
  city,
  cities,
  active,
  sortKey,
  sortDir,
  initialView,
  initialSelectedId,
  truncated = false,
}: {
  rows: ScreenListRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  q: string;
  supplierId: string | null;
  suppliers: Array<{ id: string; name: string }>;
  city: string | null;
  cities: string[];
  active: "all" | "active" | "inactive";
  sortKey: ScreensSortKey;
  sortDir: ScreensSortDir;
  initialView: "table" | "grid";
  initialSelectedId: string | null;
  truncated?: boolean;
}) {
  const [view, setView] = useState<"table" | "grid">(initialView);
  // Selección con deep-link (?pantalla=, alias ?screen=). Ver entity-list.tsx.
  const { selectedId, open: openDrawer, close: closeDrawer } = useEntitySelection(
    "/screens",
    "pantalla",
    initialSelectedId,
    ["screen"],
  );
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // URL sleek: solo salen los params no-default (q, filtros, página >1,
  // vista no-tabla, sort/dir no-default). Menos ruido, share limpio.
  const DEFAULT_DIRS: Record<ScreensSortKey, ScreensSortDir> = {
    name: "asc",
    supplier: "asc",
    city: "asc",
    impact: "desc",
    price: "desc",
  };

  const buildParams = (overrides: {
    q?: string;
    supplier?: string | null;
    city?: string | null;
    active?: string;
    sort?: string;
    dir?: string;
    view?: string;
    page?: number;
  }) => {
    const params = new URLSearchParams();
    const nextQ = overrides.q ?? q;
    if (nextQ.trim()) params.set("q", nextQ.trim());
    const nextSup = overrides.supplier !== undefined ? overrides.supplier : supplierId;
    if (nextSup) params.set("proveedor", nextSup);
    const nextCity = overrides.city !== undefined ? overrides.city : city;
    if (nextCity) params.set("ciudad", nextCity);
    const nextActive = overrides.active ?? active;
    if (nextActive !== "all") params.set("estado", nextActive);
    const nextSort = overrides.sort ?? sortKey;
    const nextDir = overrides.dir ?? sortDir;
    if (nextSort !== "name" || nextDir !== DEFAULT_DIRS[nextSort as ScreensSortKey]) {
      params.set("sort", nextSort);
      params.set("dir", nextDir);
    }
    const nextView = overrides.view ?? (view === "grid" ? "grid" : "table");
    if (nextView !== "table") params.set("view", nextView);
    const nextPage = overrides.page ?? page;
    if (nextPage > 1) params.set("page", String(nextPage));
    return params.toString();
  };

  const toggleSort = (key: ScreensSortKey) => {
    const nextDir: ScreensSortDir = key === sortKey ? (sortDir === "asc" ? "desc" : "asc") : key === "name" || key === "supplier" || key === "city" ? "asc" : "desc";
    startTransition(() => {
      router.replace(`/screens?${buildParams({ page: 1, sort: key, dir: nextDir })}`);
    });
  };

  const setFilter = (patch: { supplier?: string | null; city?: string | null; active?: string }) => {
    startTransition(() => {
      router.replace(`/screens?${buildParams({ page: 1, ...patch })}`);
    });
  };

  const filtersActive = q.trim() !== "" || supplierId !== null || city !== null || active !== "all";
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const goTo = (next: number) => {
    startTransition(() => {
      router.replace(`/screens?${buildParams({ page: next })}`);
    });
  };

  const switchView = (next: "table" | "grid") => {
    setView(next);
    startTransition(() => {
      router.replace(`/screens?${buildParams({ view: next })}`, { scroll: false });
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar pantalla, distrito, ciudad, proveedor o código…"
          ariaLabel="Buscar pantallas"
          onSearch={(value) => {
            startTransition(() => {
              router.replace(`/screens?${buildParams({ q: value, page: 1 })}`);
            });
          }}
        />
        <FilterSelect
          value={supplierId ?? "all"}
          onChange={(v) => setFilter({ supplier: v === "all" ? null : v })}
          ariaLabel="Filtrar por proveedor"
          placeholder="Proveedor"
          display={(value) =>
            value === "all" ? "Todo proveedor" : (suppliers.find((s) => s.id === value)?.name ?? "Proveedor")
          }
        >
          <SelectItem value="all">Todo proveedor</SelectItem>
          {suppliers.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect
          value={city ?? "all"}
          onChange={(v) => setFilter({ city: v === "all" ? null : v })}
          ariaLabel="Filtrar por ciudad"
          placeholder="Ciudad"
          display={(value) => (value === "all" ? "Toda ciudad" : String(value))}
        >
          <SelectItem value="all">Toda ciudad</SelectItem>
          {cities.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect
          value={active}
          onChange={(v) => setFilter({ active: v })}
          ariaLabel="Filtrar por estado"
          placeholder="Estado"
          display={(value) => (value === "all" ? "Todas" : value === "active" ? "Activas" : "Inactivas")}
        >
          <SelectItem value="all">Todas</SelectItem>
          <SelectItem value="active">Activas</SelectItem>
          <SelectItem value="inactive">Inactivas</SelectItem>
        </FilterSelect>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => {
              startTransition(() => {
                router.replace(`/screens?${buildParams({ q: "", supplier: null, city: null, active: "all", page: 1 })}`);
              });
            }}
          >
            <FilterX aria-hidden />
            Limpiar
          </Button>
        )}
        <span className="flex items-center gap-1" role="group" aria-label="Cambiar vista">
          <AppTooltip tip="Vista lista">
            <Button
              size="icon"
              variant={view === "table" ? "default" : "outline"}
              onClick={() => switchView("table")}
              aria-pressed={view === "table"}
              aria-label="Vista lista"
            >
              <ListIcon aria-hidden />
            </Button>
          </AppTooltip>
          <AppTooltip tip="Vista grilla">
            <Button
              size="icon"
              variant={view === "grid" ? "default" : "outline"}
              onClick={() => switchView("grid")}
              aria-pressed={view === "grid"}
              aria-label="Vista grilla"
            >
              <LayoutGrid aria-hidden />
            </Button>
          </AppTooltip>
        </span>
        <EntityCount total={totalCount} truncated={truncated} pending={isPending} />
      </div>

      {view === "table" ? (
        <AppCard variant="table">
          <DataTable>
            <DataTableHeader>
              <DataTableTh aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeaderButton active={sortKey === "name"} dir={sortDir} onClick={() => toggleSort("name")} ariaLabel="Ordenar por pantalla">
                  Pantalla
                </SortHeaderButton>
              </DataTableTh>
              <DataTableTh aria-sort={sortKey === "supplier" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeaderButton active={sortKey === "supplier"} dir={sortDir} onClick={() => toggleSort("supplier")} ariaLabel="Ordenar por proveedor">
                  Proveedor
                </SortHeaderButton>
              </DataTableTh>
              <DataTableTh aria-sort={sortKey === "city" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeaderButton active={sortKey === "city"} dir={sortDir} onClick={() => toggleSort("city")} ariaLabel="Ordenar por ciudad">
                  Ciudad
                </SortHeaderButton>
              </DataTableTh>
              <DataTableTh>Medidas</DataTableTh>
              <DataTableTh numeric aria-sort={sortKey === "impact" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeaderButton active={sortKey === "impact"} dir={sortDir} alignRight onClick={() => toggleSort("impact")} ariaLabel="Ordenar por impactos">
                  Impactos/día
                </SortHeaderButton>
              </DataTableTh>
              <DataTableTh numeric aria-sort={sortKey === "price" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeaderButton active={sortKey === "price"} dir={sortDir} alignRight onClick={() => toggleSort("price")} ariaLabel="Ordenar por precio">
                  Precio
                </SortHeaderButton>
              </DataTableTh>
              <DataTableTh>Estado</DataTableTh>
            </DataTableHeader>
            <DataTableBody>
              {rows.map((s) => (
                <DataTableRow key={s.id} onClick={() => openDrawer(s.id)} className="cursor-pointer">
                  <DataTableTd className="max-w-[260px] truncate px-3 py-4 font-medium">
                    {toTitleCase(s.name)}
                    {s.district && <span className="ml-2 font-normal text-muted-foreground">{s.district}</span>}
                  </DataTableTd>
                  <DataTableTd className="px-3 py-4 text-[13px]">{s.supplier_name ?? "—"}</DataTableTd>
                  <DataTableTd className="px-3 py-4 text-[13px] text-muted-foreground">{s.city ?? "—"}</DataTableTd>
                  <DataTableTd className="px-3 py-4 text-[13px] whitespace-nowrap tabular-nums">{fmtMedidas(s)}</DataTableTd>
                  <DataTableTd numeric className="px-3 py-4 tabular-nums">
                    {s.impact_day !== null ? formatNumber(s.impact_day) : "—"}
                  </DataTableTd>
                  <DataTableTd numeric className="px-3 py-4 tabular-nums">
                    {s.price_pen !== null ? `S/ ${formatNumber(s.price_pen)}` : "—"}
                  </DataTableTd>
                  <DataTableTd className="px-3 py-4">
                    <Badge variant={s.is_active ? "success" : "secondary"} className="font-normal" title={s.is_active ? "Pantalla activa" : "Pantalla inactiva"}>
                      {s.is_active ? "Activa" : "Inactiva"}
                    </Badge>
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
                      <p className="text-sm font-medium">{filtersActive ? "Sin resultados para ese filtro" : "Aún no hay pantallas"}</p>
                      <p className="text-xs text-muted-foreground">
                        {filtersActive ? "Prueba con otro nombre, proveedor o ciudad." : "Todavía no hay inventario cargado."}
                      </p>
                      {filtersActive && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-1"
                          onClick={() => {
                            startTransition(() => {
                              router.replace(`/screens?${buildParams({ q: "", supplier: null, city: null, active: "all", page: 1 })}`);
                            });
                          }}
                        >
                          <FilterX aria-hidden />
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
      ) : rows.length > 0 ? (
        <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3")}>
          {rows.map((s) => (
            <article
              key={s.id}
              onClick={() => openDrawer(s.id)}
              className="cursor-pointer rounded-xl bg-card p-5 ring-1 ring-foreground/10 transition-shadow hover:shadow-md hover:ring-primary/30"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium tracking-tight">{toTitleCase(s.name)}</h3>
                <Badge variant={s.is_active ? "success" : "secondary"} className="font-normal" title={s.is_active ? "Pantalla activa" : "Pantalla inactiva"}>
                  {s.is_active ? "Activa" : "Inactiva"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                {[s.supplier_name, [s.district, s.city].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "—"}
              </p>
              <p className="mt-2 truncate text-xs text-muted-foreground tabular-nums">
                {fmtMedidas(s)}
                {s.impact_day !== null ? ` · ${formatNumber(s.impact_day)} impactos/día` : ""}
                {s.price_pen !== null ? ` · S/ ${formatNumber(s.price_pen)}` : ""}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <EntityEmpty
          filtered={filtersActive}
          emptyTitle="Aún no hay pantallas"
          emptyHint="Todavía no hay inventario cargado."
          filteredHint="Prueba con otro nombre, proveedor o ciudad."
          onClear={() => {
            startTransition(() => {
              router.replace(`/screens?${buildParams({ q: "", supplier: null, city: null, active: "all", page: 1 })}`);
            });
          }}
        />
      )}

      {selectedId && <PantallaDrawer key={selectedId} screenId={selectedId} onClose={closeDrawer} />}

      <EntityPagination page={page} totalPages={totalPages} pending={isPending} onGo={goTo} />
    </div>
  );
}
