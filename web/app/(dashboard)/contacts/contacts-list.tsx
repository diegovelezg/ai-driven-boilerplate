"use client";

import { useMemo, useState } from "react";
import { FilterX, LayoutGrid, List as ListIcon, Star, Users } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Metric, MetricRow } from "@/components/metric";
import { SectionHeading } from "@/components/section-heading";
import { AppTooltip } from "@/components/ui/app-tooltip";
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
import { CrmStatusFilterSelect } from "@/components/crm-status-filter";
import { EntityCount, EntityEmpty, useEntitySelection, useListNav } from "@/components/entity-list";
import { ExportCsvButton } from "@/components/export-csv-button";
import { CompanyPrincipalBadge } from "@/components/company-badges";
import { ArchivedBadge } from "@/components/badges";
import { type CrmStatusFilter } from "@/lib/crm";
import { formatNumber, toTitleCase } from "@/lib/format";
import { cn } from "cn";
import type { CrmContactListItem } from "@/lib/crm-db";
import type { MemberRole } from "@/lib/roles";
import { ContactDrawer } from "./contact-drawer";

function fullName(c: CrmContactListItem): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
}

export function ContactsList({
  rows,
  companies,
  q,
  companyId,
  status,
  initialView,
  initialSelectedId,
  myRole,
  totalCount,
  truncated = false,
}: {
  rows: CrmContactListItem[];
  companies: Array<{ id: string; name: string }>;
  q: string;
  companyId: string | null;
  status: CrmStatusFilter;
  initialView: "table" | "grid";
  initialSelectedId: string | null;
  myRole: MemberRole | null;
  totalCount?: number;
  truncated?: boolean;
}) {
  // Selección con deep-link (?contact=, alias ?contacto=). Ver entity-list.tsx.
  const { selectedId, open: openDrawer, close: closeDrawer } = useEntitySelection(
    "/contacts",
    "contact",
    initialSelectedId,
    ["contacto"],
  );
  const [view, setView] = useState<"table" | "grid">(initialView);
  const { go: goNav, isPending } = useListNav("/contacts");

  const buildParams = (patch: { q?: string; company?: string | null; status?: string | null; view?: string }) => {
    const params = new URLSearchParams();
    const nextQ = patch.q ?? q;
    if (nextQ.trim()) params.set("q", nextQ.trim());
    const nextCompany = patch.company !== undefined ? patch.company : companyId;
    if (nextCompany) params.set("company", nextCompany);
    const nextStatus = patch.status !== undefined ? patch.status : status;
    if (nextStatus && nextStatus !== "active") params.set("status", nextStatus);
    params.set("view", patch.view ?? (view === "grid" ? "grid" : "table"));
    return params.toString();
  };

  const go = (patch: { q?: string; company?: string | null; status?: string | null }) => {
    goNav(buildParams(patch));
  };

  const switchView = (next: "table" | "grid") => {
    setView(next);
    goNav(buildParams({ view: next }), { scroll: false });
  };

  const summary = useMemo(() => {
    let primary = 0;
    for (const c of rows) if (c.is_primary) primary += 1;
    return { total: rows.length, primary };
  }, [rows]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const hasFilter = q.trim() !== "" || companyId !== null || status !== "active";
  const exportParams = new URLSearchParams({ entity: "contacts" });
  if (q.trim()) exportParams.set("q", q.trim());
  if (companyId) exportParams.set("company", companyId);

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Resumen · contactos">
        <SectionHeading title="Resumen" hint="Contactos en vista con los filtros actuales." tone="emerald" />
        <MetricRow columns={2} aria-label="Resumen">
          <Metric
            label="En vista"
            icon={Users}
            value={formatNumber(summary.total)}
            hint={
              truncated
                ? `Muestra parcial de ${formatNumber(totalCount ?? summary.total)} en total`
                : "Contactos con los filtros actuales"
            }
          />
          <Metric
            label="Principales"
            icon={Star}
            value={formatNumber(summary.primary)}
            hint="Contacto de referencia en su empresa"
            tone={summary.primary > 0 ? "primary" : "default"}
          />
        </MetricRow>
      </section>

      <div className="flex flex-wrap items-center gap-2.5" role="search" aria-label="Filtros de contactos">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar nombre, empresa, email, cargo o teléfono…"
          ariaLabel="Buscar contactos"
          onSearch={(value) => go({ q: value })}
        />
        <FilterSelect
          value={companyId ?? "all"}
          onChange={(v) => go({ company: v === "all" ? null : v })}
          ariaLabel="Filtrar por empresa"
          placeholder="Empresa"
          display={(value) => {
            if (value === "all") return "Empresa: todas";
            const found = companies.find((c) => c.id === value);
            return `Empresa: ${found ? toTitleCase(found.name) : "—"}`;
          }}
        >
          <SelectItem value="all">Todas</SelectItem>
          {companies.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {toTitleCase(c.name)}
            </SelectItem>
          ))}
        </FilterSelect>
        <CrmStatusFilterSelect status={status} onStatus={(s) => go({ status: s })} />
        {hasFilter && (
          <Button variant="ghost" size="sm" disabled={isPending} onClick={() => go({ q: "", company: null, status: null })}>
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
          <AppTooltip tip="Vista tarjetas">
            <Button
              size="icon"
              variant={view === "grid" ? "default" : "outline"}
              onClick={() => switchView("grid")}
              aria-pressed={view === "grid"}
              aria-label="Vista tarjetas"
            >
              <LayoutGrid aria-hidden />
            </Button>
          </AppTooltip>
        </span>
        <ExportCsvButton href={`/api/export?${exportParams.toString()}`} label="Exportar contactos filtrados a CSV" />
        <EntityCount total={rows.length} pending={isPending} />
      </div>

      {view === "table" ? (
      <AppCard variant="table">
        <DataTable>
          <DataTableHeader>
            <DataTableTh>Nombre</DataTableTh>
            <DataTableTh>Empresa</DataTableTh>
            <DataTableTh>Cargo</DataTableTh>
            <DataTableTh>Contacto</DataTableTh>
            <DataTableTh>Principal</DataTableTh>
          </DataTableHeader>
          <DataTableBody>
            {rows.map((c) => (
              <DataTableRow
                key={c.id}
                tabIndex={0}
                role="button"
                aria-label={`Abrir contacto ${fullName(c)}`}
                onClick={() => openDrawer(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openDrawer(c.id);
                  }
                }}
                className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <DataTableTd className="font-medium">{fullName(c) === "—" ? "—" : toTitleCase(fullName(c))}{c.deleted_at && <ArchivedBadge className="ml-2" />}</DataTableTd>
                <DataTableTd
                  className="max-w-[220px] truncate text-[13px] text-muted-foreground"
                  title={c.company_name ?? undefined}
                >
                  {c.company_name ? toTitleCase(c.company_name) : "—"}
                </DataTableTd>
                <DataTableTd className="text-[13px]">{c.job_title ?? "—"}</DataTableTd>
                <DataTableTd className="text-[13px] text-muted-foreground">
                  {c.email ?? c.phone ?? "—"}
                </DataTableTd>
                <DataTableTd>
                  <CompanyPrincipalBadge isPrimary={c.is_primary} />
                </DataTableTd>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      </AppCard>
      ) : rows.length > 0 ? (
        <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3")}>
          {rows.map((c) => {
            const name = fullName(c);
            const displayName = name === "—" ? "Contacto sin nombre" : toTitleCase(name);
            return (
              <article
                key={c.id}
                tabIndex={0}
                role="button"
                aria-label={`Abrir contacto ${displayName}`}
                onClick={() => openDrawer(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openDrawer(c.id);
                  }
                }}
                className="cursor-pointer rounded-xl bg-card p-5 ring-1 ring-foreground/10 transition-shadow hover:shadow-md hover:ring-primary/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium tracking-tight">{displayName}</h3>
                  <span className="flex items-center gap-1.5">
                    {c.deleted_at && <ArchivedBadge />}
                    <CompanyPrincipalBadge isPrimary={c.is_primary} />
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {[c.company_name ? toTitleCase(c.company_name) : null, c.job_title].filter(Boolean).join(" · ") || "—"}
                </p>
                <p className="mt-2 truncate text-xs text-muted-foreground">{c.email ?? c.phone ?? "Sin contacto"}</p>
              </article>
            );
          })}
        </div>
      ) : null}

      {rows.length === 0 && (
        <EntityEmpty
          filtered={hasFilter}
          emptyTitle="Aún no hay contactos"
          emptyHint="Crea el primero o agrégalo desde la ficha de su empresa."
          onClear={hasFilter ? () => go({ q: "", company: null, status: null }) : undefined}
        />
      )}

      {selected && <ContactDrawer key={selected.id} contact={selected} myRole={myRole} onClose={closeDrawer} />}
    </div>
  );
}
