"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableRow,
  DataTableTd,
  DataTableTh,
  SortHeaderButton,
  type SortDir,
} from "@/components/data-table";
import { formatMoney, formatNumber } from "@/lib/format";
import type { ProductWithStats } from "@/lib/product-stats";
import { ProductDrawer } from "./product-drawer";

function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return "—";
  const meses = [
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
  ];
  return `${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;
}

type SortKey = "title" | "estado" | "qty" | "revenue" | "qty30" | "last";

const PAGE_SIZE = 50;

// Solo lectura: sin gestión de catálogo (sin columna Acción).
// Click en la fila abre el drawer con el detalle de lo vendido.
export function ProductsList({ rows, total, truncated, activeTotal, inactiveTotal, market }: { rows: ProductWithStats[]; total: number; truncated: boolean; activeTotal: number; inactiveTotal: number; market: string | null }) {
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Texto: asc primero; números/fechas: desc primero (lo más vendido/reciente).
      setSortDir(key === "title" || key === "estado" ? "asc" : "desc");
    }
  };

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    // Default: Monto DESC, luego Cant DESC, luego Ítem ASC.
    const byQtyDescThenTitle = (a: ProductWithStats, b: ProductWithStats): number =>
      (b.qty_all - a.qty_all) || a.title.localeCompare(b.title, "es");
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case "title":
          return a.title.localeCompare(b.title, "es") * dir || (b.revenue_all - a.revenue_all);
        case "estado":
          return (Number(a.is_active) - Number(b.is_active)) * dir || byQtyDescThenTitle(a, b);
        case "qty":
          return (a.qty_all - b.qty_all) * dir || a.title.localeCompare(b.title, "es");
        case "revenue": {
          const primary = (a.revenue_all - b.revenue_all) * dir;
          if (primary !== 0) return primary;
          return byQtyDescThenTitle(a, b);
        }
        case "qty30":
          return (a.qty_30d - b.qty_30d) * dir || byQtyDescThenTitle(a, b);
        case "last":
          return (String(a.last_sold_at ?? "") < String(b.last_sold_at ?? "") ? -1 : String(a.last_sold_at ?? "") > String(b.last_sold_at ?? "") ? 1 : 0) * dir || byQtyDescThenTitle(a, b);
        default:
          return 0;
      }
    });
  }, [rows, sortKey, sortDir]);

  // Reset a página 1 al cambiar filtro/búsqueda; clamp si el sort recorta páginas.
  useEffect(() => {
    setPage(1);
  }, [rows]);
  useEffect(() => {
    if (selectedId && !rows.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [rows, selectedId]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const sortProps = (key: SortKey, alignRight = false, ariaLabel: string) => ({
    active: sortKey === key,
    dir: sortDir,
    alignRight,
    onClick: () => toggleSort(key),
    ariaLabel,
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {formatNumber(activeTotal)} activos · {formatNumber(inactiveTotal)} inactivos ·{" "}
        {formatNumber(total)} en catálogo
        {rows.length !== total ? ` (mostrando ${formatNumber(rows.length)})` : truncated ? " (truncado)" : ""}.
        Sin movimiento = sin cifras. Solo lectura.
      </p>
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">Sin ítems con este filtro.</p>
      )}
      <AppCard variant="table">
        <DataTable>
          <DataTableHeader>
            <DataTableTh aria-sort={sortKey === "title" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton {...sortProps("title", false, "Ordenar por ítem")}>Ítem</SortHeaderButton>
            </DataTableTh>
            <DataTableTh aria-sort={sortKey === "estado" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton {...sortProps("estado", false, "Ordenar por estado")}>Estado</SortHeaderButton>
            </DataTableTh>
            <DataTableTh numeric aria-sort={sortKey === "qty" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton {...sortProps("qty", true, "Ordenar por cantidad")}>Cant.</SortHeaderButton>
            </DataTableTh>
            <DataTableTh numeric aria-sort={sortKey === "revenue" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton {...sortProps("revenue", true, "Ordenar por monto")}>Monto</SortHeaderButton>
            </DataTableTh>
            <DataTableTh numeric aria-sort={sortKey === "qty30" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton {...sortProps("qty30", true, "Ordenar por 30 días")}>30d</SortHeaderButton>
            </DataTableTh>
            <DataTableTh numeric aria-sort={sortKey === "last" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton {...sortProps("last", true, "Ordenar por actividad")}>Actividad</SortHeaderButton>
            </DataTableTh>
          </DataTableHeader>
          <DataTableBody>
            {paged.map((r) => (
              <DataTableRow key={r.id} onClick={() => setSelectedId(r.id)} className="cursor-pointer">
                <DataTableTd>
                  <span className="font-medium">{r.title}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {r.platform_status ?? "—"}
                  </span>
                </DataTableTd>
                <DataTableTd>
                  <span
                    className={
                      r.is_active
                        ? "inline-block rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600"
                        : "inline-block rounded-full bg-zinc-500/15 px-2 py-0.5 text-xs text-zinc-500"
                    }
                  >
                    {r.is_active ? "activo" : "inactivo"}
                  </span>
                </DataTableTd>
                <DataTableTd numeric className="tabular-nums">{formatNumber(r.qty_all)}</DataTableTd>
                <DataTableTd numeric className="tabular-nums">
                  {r.currency ? formatMoney(r.revenue_all, r.currency) : "—"}
                </DataTableTd>
                <DataTableTd numeric className="tabular-nums">{formatNumber(r.qty_30d)}</DataTableTd>
                <DataTableTd numeric className="text-xs text-muted-foreground">
                  {fechaCorta(r.last_sold_at)}
                </DataTableTd>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      </AppCard>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground tabular-nums">
          Página {formatNumber(safePage)} de {formatNumber(totalPages)} · {formatNumber(sorted.length)} ítems
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Siguiente
          </Button>
        </div>
      </div>
      {selected && (
        <ProductDrawer summary={selected} market={market} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
