"use client";

import { useRouter } from "next/navigation";
import { FilterSelect, SelectItem } from "@/components/filter-select";

/** Filtro de moneda para Finanzas: Todas o una sola (?moneda=). */
export function CurrencyFilter({ value, currencies }: { value: string; currencies: string[] }) {
  const router = useRouter();
  return (
    <FilterSelect
      value={value}
      onChange={(v) => {
        const params = new URLSearchParams(window.location.search);
        if (v === "all") params.delete("moneda");
        else params.set("moneda", v);
        const qs = params.toString();
        router.replace(qs ? `/finance?${qs}` : "/finance");
      }}
      ariaLabel="Filtrar por moneda"
      placeholder="Moneda"
      display={(val) => (val === "all" ? "Moneda: todas" : `Moneda: ${val}`)}
    >
      <SelectItem value="all">Todas</SelectItem>
      {currencies.map((c) => (
        <SelectItem key={c} value={c}>
          {c}
        </SelectItem>
      ))}
    </FilterSelect>
  );
}
