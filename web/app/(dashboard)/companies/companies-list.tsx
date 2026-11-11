"use client";

import { useCallback, useRef, useState } from "react";
import { AppCard } from "@/components/app-card";
import { ArchivedBadge, AttributeBadge } from "@/components/badges";
import { ClearFiltersButton, ViewToggle } from "@/components/buttons";
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
import { FilterMultiSelect } from "@/components/filter-multi-select";
import { CrmStatusFilterSelect } from "@/components/crm-status-filter";
import { EntityCount, EntityEmpty, EntityPagination, useEntitySelection, useListNav } from "@/components/entity-list";
import { ExportCsvButton } from "@/components/export-csv-button";
import { COMPANY_KINDS, COMPANY_KIND_LABELS, companyKindsLabel, isDefaultCompanyKinds, serializeCompanyKinds, kindLabel, DEFAULT_COMPANY_KINDS, type CompanyKind, type CrmStatusFilter } from "@/lib/crm";
import { formatNumber, toTitleCase } from "@/lib/format";
import { taxIdLabel } from "@/lib/tax-id";
import { cn } from "cn";
import type { CompaniesSortDir, CompaniesSortKey } from "@/lib/crm-db";

export interface EmpresaRow {
  id: string;
  name: string;
  kind: CompanyKind | null;
  tax_id: string | null;
  country: string | null;
  domain: string | null;
  email: string | null;
  city: string | null;
  contacts_count: number;
  deleted_at: string | null;
}

export function CompaniesList({
  rows,
  totalCount,
  page,
  pageSize,
  q,
  kinds,
  status,
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
  kinds: readonly CompanyKind[];
  status: CrmStatusFilter;
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
  const { go, isPending } = useListNav("/companies");
  // Prefetch del detalle al hover/foco (mismo patrón que orders-list).
  const prefetched = useRef(new Set<string>());
  const prefetchCompany = useCallback((id: string) => {
    if (prefetched.current.has(id)) return;
    prefetched.current.add(id);
    void fetch(`/api/companies/${id}`).catch(() => {});
  }, []);

  const buildParams = useCallback(
    (overrides: { q?: string; types?: readonly CompanyKind[] | null; status?: string | null; sort?: string; dir?: string; view?: string; page?: number }) => {
      const params = new URLSearchParams();
      const nextQ = overrides.q ?? q;
      if (nextQ.trim()) params.set("q", nextQ.trim());
      const nextKinds = overrides.types !== undefined ? overrides.types : kinds;
      const serialized = nextKinds == null ? null : serializeCompanyKinds(nextKinds);
      if (serialized) params.set("type", serialized);
      const nextStatus = overrides.status !== undefined ? overrides.status : status;
      if (nextStatus && nextStatus !== "active") params.set("status", nextStatus);
      params.set("sort", overrides.sort ?? sortKey);
      params.set("dir", overrides.dir ?? sortDir);
      params.set("view", overrides.view ?? (view === "grid" ? "grid" : "table"));
      params.set("page", String(overrides.page ?? page));
      return params.toString();
    },
    [q, kinds, status, sortKey, sortDir, view, page],
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
    go(buildParams({ page: 1, sort: key, dir: nextDir }));
  };

  const setFilter = (patch: { types?: readonly CompanyKind[] | null; status?: string | null }) => {
    go(buildParams({ page: 1, ...patch }));
  };

  const filtersActive = q.trim() !== "" || !isDefaultCompanyKinds(kinds) || status !== "active";
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const exportParams = new URLSearchParams({ entity: "companies" });
  if (q.trim()) exportParams.set("q", q.trim());
  // Explícito siempre (incluido el default): la exportación debe coincidir
  // con lo visible. serializeCompanyKinds omite el default para URLs limpias.
  if (kinds.length === 0) exportParams.set("type", "none");
  else exportParams.set("type", [...kinds].join(","));
  exportParams.set("sort", sortKey);
  exportParams.set("dir", sortDir);

  const goTo = (next: number) => {
    go(buildParams({ page: next }));
  };

  const switchView = (next: "table" | "grid") => {
    setView(next);
    go(buildParams({ view: next }), { scroll: false });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar por nombre comercial, razón social, ID fiscal, dominio o email…"
          ariaLabel="Buscar empresas"
          onSearch={(value) => {
            go(buildParams({ q: value, page: 1 }));
          }}
        />
        <FilterMultiSelect<CompanyKind>
          values={kinds}
          options={COMPANY_KINDS.map((k) => ({ value: k, label: COMPANY_KIND_LABELS[k] }))}
          onChange={(next) => setFilter({ types: next })}
          ariaLabel="Filtrar por tipo"
          placeholder="Tipo"
          display={(v) => companyKindsLabel(v)}
        />
        <CrmStatusFilterSelect status={status} onStatus={(s) => setFilter({ status: s })} />
        {filtersActive && (
          <ClearFiltersButton
            disabled={isPending}
            onClear={() => {
              go(buildParams({ q: "", types: [...DEFAULT_COMPANY_KINDS], status: null, page: 1 }));
            }}
          />
        )}
        <ViewToggle view={view} onChange={switchView} />
        <ExportCsvButton href={`/api/export?${exportParams.toString()}`} label="Exportar empresas filtradas a CSV" />
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
                  onMouseEnter={() => prefetchCompany(c.id)}
                  onFocus={() => prefetchCompany(c.id)}
                  className="cursor-pointer"
                >
                  <DataTableTd className="max-w-[260px] truncate px-3 py-4 font-medium">
                    {toTitleCase(c.name)}
                    {c.domain && <span className="ml-2 font-normal text-muted-foreground">{c.domain}</span>}
                    {c.deleted_at && <ArchivedBadge fem className="ml-2" />}
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
                  <DataTableTd colSpan={4} className="px-3 py-4">
                    <EntityEmpty
                      inline
                      filtered={filtersActive}
                      emptyTitle="Aún no hay empresas"
                      emptyHint="Crea la primera desde Nueva empresa."
                      filteredHint="Prueba con otro nombre o tipo."
                      onClear={() => {
                        go(buildParams({ q: "", types: [...DEFAULT_COMPANY_KINDS], status: null, page: 1 }));
                      }}
                    />
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
              onMouseEnter={() => prefetchCompany(c.id)}
              className="cursor-pointer rounded-xl bg-card p-5 ring-1 ring-foreground/10 transition-shadow hover:shadow-md hover:ring-primary/30"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium tracking-tight">{toTitleCase(c.name)}</h3>
                <span className="flex items-center gap-1.5">
                  {c.deleted_at && <ArchivedBadge fem />}
                  <AttributeBadge label={kindLabel(c.kind)} title="Tipo de contraparte" />
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                {formatNumber(c.contacts_count)} contacto{c.contacts_count === 1 ? "" : "s"}
                {c.tax_id ? ` · ${taxIdLabel(c.country)} ${c.tax_id}` : ""}
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
            go(buildParams({ q: "", types: [...DEFAULT_COMPANY_KINDS], status: null, page: 1 }));
          }}
        />
      )}

      {selectedId && (
        <EmpresaDrawer key={selectedId} companyId={selectedId} onClose={closeDrawer} />
      )}

      <EntityPagination page={page} totalPages={totalPages} pending={isPending} onGo={goTo} />
    </div>
  );
}
