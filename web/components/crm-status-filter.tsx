"use client";

import { FilterSelect, SelectItem } from "@/components/filter-select";
import { CRM_STATUS_LABELS, CRM_STATUS_VALUES, type CrmStatusFilter } from "@/lib/crm";

/** Filtro de estado CRM (companies + contacts): mismo placeholder, display y
 *  opciones. `onStatus` recibe null para "active" (sin filtro). */
export function CrmStatusFilterSelect({
  status,
  onStatus,
}: {
  status: string;
  onStatus: (status: string | null) => void;
}) {
  return (
    <FilterSelect
      value={status}
      onChange={(v) => onStatus(v === "active" ? null : v)}
      ariaLabel="Filtrar por estado"
      placeholder="Estado"
      display={(value) => (CRM_STATUS_LABELS[value as CrmStatusFilter] ?? String(value))}
    >
      {CRM_STATUS_VALUES.map((s) => (
        <SelectItem key={s} value={s}>{CRM_STATUS_LABELS[s]}</SelectItem>
      ))}
    </FilterSelect>
  );
}
