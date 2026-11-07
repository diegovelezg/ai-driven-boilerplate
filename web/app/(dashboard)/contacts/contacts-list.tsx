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
import { CompanyPrincipalBadge } from "@/components/company-badges";
import { formatNumber, toTitleCase } from "@/lib/format";
import type { CrmContactListItem } from "@/lib/crm-db";
import { ContactDrawer } from "./contact-drawer";

function fullName(c: CrmContactListItem): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
}

export function ContactsList({
  rows,
  companies,
  q,
  companyId,
  initialSelectedId,
}: {
  rows: CrmContactListItem[];
  companies: Array<{ id: string; name: string }>;
  q: string;
  companyId: string | null;
  initialSelectedId: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const go = (patch: { q?: string; company?: string | null }) => {
    const params = new URLSearchParams();
    const nextQ = patch.q ?? q;
    if (nextQ.trim()) params.set("q", nextQ.trim());
    const nextCompany = patch.company !== undefined ? patch.company : companyId;
    if (nextCompany) params.set("company", nextCompany);
    startTransition(() => {
      router.replace(`/contacts?${params.toString()}`);
    });
  };

  const summary = useMemo(() => {
    let primary = 0;
    for (const c of rows) if (c.is_primary) primary += 1;
    return { total: rows.length, primary };
  }, [rows]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const hasFilter = q.trim() !== "" || companyId !== null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2.5" aria-label="Resumen">
        <div className="rounded-xl border bg-card px-3.5 py-3">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">En vista</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(summary.total)}</p>
        </div>
        <div className="rounded-xl border bg-card px-3.5 py-3">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Principales</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(summary.primary)}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5" role="search" aria-label="Filtros de contactos">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar por nombre, email, cargo…"
          ariaLabel="Buscar contactos"
          onSearch={(value) => go({ q: value })}
        />
        <FilterSelect
          value={companyId ?? "all"}
          onChange={(v) => go({ company: v === "all" ? null : v })}
          ariaLabel="Filtrar por empresa"
          placeholder="Empresa"
          widthClass="w-56"
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
        {hasFilter && (
          <Button variant="ghost" size="sm" disabled={isPending} onClick={() => go({ q: "", company: null })}>
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
                onClick={() => setSelectedId(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedId(c.id);
                  }
                }}
                className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <DataTableTd className="font-medium">{fullName(c) === "—" ? "—" : toTitleCase(fullName(c))}</DataTableTd>
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
            {rows.length === 0 && (
              <DataTableRow>
                <DataTableTd colSpan={5} className="px-3 py-10">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-2 text-center">
                    <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden>
                      <SearchX className="size-5" />
                    </span>
                    <p className="text-sm font-medium">
                      {hasFilter ? "Sin resultados para ese filtro" : "Aún no hay contactos"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {hasFilter
                        ? "Prueba con otro nombre o empresa."
                        : "Se crean desde el drawer de cada empresa, tab Contactos."}
                    </p>
                    {hasFilter && (
                      <Button variant="outline" size="sm" className="mt-1" onClick={() => go({ q: "", company: null })}>
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

      {selected && <ContactDrawer contact={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
