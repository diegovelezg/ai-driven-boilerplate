"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilterX, LayoutGrid, List as ListIcon } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmpresaDrawer } from "./empresa-drawer";
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
import { EntityCount, EntityEmpty, EntityPagination, useEntitySelection } from "@/components/entity-list";
import { COMPANY_KINDS, COMPANY_KIND_LABELS, kindLabel, type CompanyKind } from "@/lib/crm";
import { formatNumber, toTitleCase } from "@/lib/format";
import { cn } from "cn";
import type { CompaniesSortDir, CompaniesSortKey } from "@/lib/crm-db";

export interface EmpresaRow {
  id: string;
  name: string;
  kind: CompanyKind | null;
  tax_id: string | null;
  domain: string | null;
  email: string | null;
  city: string | null;
  contacts_count: number;
}

export function CompaniesList({
  rows,
  totalCount,
  page,
  pageSize,
  q,
  kind,
  sortKey,
  sortDir,
  initialView,
  initialSelectedId,
}: {
  rows: EmpresaRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  q: string;
  kind: CompanyKind | null;
  sortKey: CompaniesSortKey;
  sortDir: CompaniesSortDir;
  initialView: "table" | "grid";
  initialSelectedId: string | null;
}) {
  const [view, setView] = useState<"table" | "grid">(initialView);
  // Selección con deep-link (?company=, alias ?empresa=): abrir/cerrar escribe
  // la URL y la URL manda (back/forward, deep-link). Ver entity-list.tsx.
  const { selectedId, open: openDrawer, close: closeDrawer } = useEntitySelection(
    "/companies",
    "company",
    initialSelectedId,
    ["empresa"],
  );
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const buildParams = useCallback(
    (overrides: { q?: string; type?: string | null; sort?: string; dir?: string; view?: string; page?: number }) => {
      const params = new URLSearchParams();
      const nextQ = overrides.q ?? q;
      if (nextQ.trim()) params.set("q", nextQ.trim());
      const nextTipo = overrides.type !== undefined ? overrides.type : kind;
      if (nextTipo) params.set("type", nextTipo);
      params.set("sort", overrides.sort ?? sortKey);
      params.set("dir", overrides.dir ?? sortDir);
      params.set("view", overrides.view ?? (view === "grid" ? "grid" : "table"));
      params.set("page", String(overrides.page ?? page));
      return params.toString();
    },
    [q, kind, sortKey, sortDir, view, page],
  );

  // El sort ordena en servidor (Supabase) sobre todos los datos.
  // Texto ASC primero; conteos DESC primero (lo más relevante).
  const toggleSort = (key: CompaniesSortKey) => {
    let nextDir: CompaniesSortDir;
    if (key === sortKey) {
      nextDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      nextDir = key === "contacts" ? "desc" : "asc";
    }
    startTransition(() => {
      router.replace(`/companies?${buildParams({ page: 1, sort: key, dir: nextDir })}`);
    });
  };

  const setFilter = (patch: { type?: string | null }) => {
    startTransition(() => {
      router.replace(`/companies?${buildParams({ page: 1, ...patch })}`);
    });
  };

  const filtersActive = q.trim() !== "" || kind !== null;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const goTo = (next: number) => {
    startTransition(() => {
      router.replace(`/companies?${buildParams({ page: next })}`);
    });
  };

  const switchView = (next: "table" | "grid") => {
    setView(next);
    startTransition(() => {
      router.replace(`/companies?${buildParams({ view: next })}`, { scroll: false });
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar por nombre, ID fiscal, dominio o email…"
          ariaLabel="Buscar empresas"
          onSearch={(value) => {
            startTransition(() => {
              router.replace(`/companies?${buildParams({ q: value, page: 1 })}`);
            });
          }}
        />
        <FilterSelect
          value={kind ?? "all"}
          onChange={(v) => setFilter({ type: v === "all" ? null : v })}
          ariaLabel="Filtrar por tipo"
          placeholder="Tipo"
          display={(value) =>
            value === "all" ? "Todo tipo" : COMPANY_KIND_LABELS[value as CompanyKind] ?? String(value)
          }
        >
          <SelectItem value="all">Todo tipo</SelectItem>
          {COMPANY_KINDS.map((k) => (
            <SelectItem key={k} value={k}>{COMPANY_KIND_LABELS[k]}</SelectItem>
          ))}
        </FilterSelect>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => {
              startTransition(() => {
                router.replace(`/companies?${buildParams({ q: "", type: null, page: 1 })}`);
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
        <EntityCount total={totalCount} pending={isPending} />
      </div>

      {view === "table" ? (
        <AppCard variant="table">
          <DataTable>
            <DataTableHeader>
              <DataTableTh aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeaderButton active={sortKey === "name"} dir={sortDir} onClick={() => toggleSort("name")} ariaLabel="Ordenar por empresa">
                  Empresa
                </SortHeaderButton>
              </DataTableTh>
              <DataTableTh aria-sort={sortKey === "type" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeaderButton active={sortKey === "type"} dir={sortDir} onClick={() => toggleSort("type")} ariaLabel="Ordenar por tipo">
                  Tipo
                </SortHeaderButton>
              </DataTableTh>
              <DataTableTh numeric aria-sort={sortKey === "contacts" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeaderButton active={sortKey === "contacts"} dir={sortDir} alignRight onClick={() => toggleSort("contacts")} ariaLabel="Ordenar por contactos">
                  Contactos
                </SortHeaderButton>
              </DataTableTh>
              <DataTableTh aria-sort={sortKey === "tax_id" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeaderButton active={sortKey === "tax_id"} dir={sortDir} onClick={() => toggleSort("tax_id")} ariaLabel="Ordenar por ID fiscal">
                  ID fiscal
                </SortHeaderButton>
              </DataTableTh>
            </DataTableHeader>
            <DataTableBody>
              {rows.map((c) => (
                <DataTableRow
                  key={c.id}
                  onClick={() => openDrawer(c.id)}
                  className="cursor-pointer"
                >
                  <DataTableTd className="max-w-[260px] truncate px-3 py-4 font-medium">
                    {toTitleCase(c.name)}
                    {c.domain && <span className="ml-2 font-normal text-muted-foreground">{c.domain}</span>}
                  </DataTableTd>
                  <DataTableTd className="px-3 py-4 text-[13px]">{kindLabel(c.kind)}</DataTableTd>
                  <DataTableTd numeric className="px-3 py-4 tabular-nums">
                    {formatNumber(c.contacts_count)}
                  </DataTableTd>
                  <DataTableTd className="px-3 py-4 text-[13px] text-muted-foreground">
                    {c.tax_id ?? <span className="text-muted-foreground/60">—</span>}
                  </DataTableTd>
                </DataTableRow>
              ))}
              {rows.length === 0 && (
                <DataTableRow>
                  <DataTableTd colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                    {q ? `Sin resultados para “${q}”.` : "Sin empresas."}
                  </DataTableTd>
                </DataTableRow>
              )}
            </DataTableBody>
          </DataTable>
        </AppCard>
      ) : rows.length > 0 ? (
        <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3")}>
          {rows.map((c) => (
            <article
              key={c.id}
              onClick={() => openDrawer(c.id)}
              className="cursor-pointer rounded-xl bg-card p-5 ring-1 ring-foreground/10 transition-shadow hover:shadow-md hover:ring-primary/30"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium tracking-tight">{toTitleCase(c.name)}</h3>
                <Badge variant="secondary">{kindLabel(c.kind)}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                {formatNumber(c.contacts_count)} contacto{c.contacts_count === 1 ? "" : "s"}
                {c.tax_id ? ` · ID fiscal ${c.tax_id}` : ""}
              </p>
              {(c.domain || c.city) && (
                <p className="mt-2 truncate text-xs text-muted-foreground">
                  {[c.domain, c.city].filter(Boolean).join(" · ")}
                </p>
              )}
            </article>
          ))}
        </div>
      ) : (
        <EntityEmpty
          filtered={filtersActive}
          emptyTitle="Aún no hay empresas"
          emptyHint="Crea la primera desde Nueva empresa."
          filteredHint="Prueba con otro nombre o tipo."
          onClear={() => {
            startTransition(() => {
              router.replace(`/companies?${buildParams({ q: "", type: null, page: 1 })}`);
            });
          }}
        />
      )}

      {selectedId && (
        <EmpresaDrawer companyId={selectedId} onClose={closeDrawer} />
      )}

      <EntityPagination page={page} totalPages={totalPages} pending={isPending} onGo={goTo} />
    </div>
  );
}
