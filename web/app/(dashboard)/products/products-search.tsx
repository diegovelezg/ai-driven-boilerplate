"use client";

import { useRouter } from "next/navigation";
import { FilterSearch } from "@/components/filter-search";

export function ProductsSearch({ q, estado }: { q: string; estado: string }) {
  const router = useRouter();
  return (
    <FilterSearch
      initialValue={q}
      placeholder="Buscar ítem…"
      ariaLabel="Buscar ítem"
      onSearch={(query) => {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        if (estado !== "activos") params.set("estado", estado);
        const qs = params.toString();
        router.replace(`/products${qs ? `?${qs}` : ""}`);
      }}
    />
  );
}
