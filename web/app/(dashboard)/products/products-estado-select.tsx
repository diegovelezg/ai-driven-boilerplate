"use client";

import { useRouter } from "next/navigation";
import { FilterSelect, SelectItem } from "@/components/filter-select";

export function ProductsEstadoSelect({
  estado,
  q,
}: {
  estado: string;
  q: string;
}) {
  const router = useRouter();

  const go = (v: string | null) => {
    if (!v) return;
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (v !== "activos") params.set("estado", v);
    const qs = params.toString();
    router.replace(`/products${qs ? `?${qs}` : ""}`);
  };

  return (
    <FilterSelect value={estado} onChange={(v) => go(v)} ariaLabel="Filtrar por estado" widthClass="w-36" placeholder="Estado">
      <SelectItem value="todos">Todos</SelectItem>
      <SelectItem value="activos">Activos</SelectItem>
      <SelectItem value="inactivos">Inactivos</SelectItem>
    </FilterSelect>
  );
}
