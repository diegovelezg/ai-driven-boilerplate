"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { CalendarDays } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/buttons";
import { FilterSearch } from "@/components/filter-search";
import { FilterSelect, SelectItem } from "@/components/filter-select";
import { addDays, formatDayMonth, formatNumber, todayLima } from "@/lib/format";
import { PantallaDrawer } from "../screens/pantalla-drawer";
import type { ScreenConflict } from "@/lib/availability";

export interface OccupancyScreen {
  id: string;
  name: string;
  city: string | null;
  venue_name: string | null;
}

export type OccupancyEstado = "all" | "libre" | "ocupada";

export function OccupancyTimeline({
  screens,
  conflicts,
  desde,
  dias,
  q,
  ciudad,
  cities,
  supplierValue,
  suppliers,
  casaName,
  estado,
  truncated = false,
}: {
  screens: OccupancyScreen[];
  conflicts: ScreenConflict[];
  desde: string;
  dias: number;
  q: string;
  ciudad: string | null;
  cities: string[];
  supplierValue: string;
  suppliers: Array<{ id: string; name: string }>;
  casaName: string | null;
  estado: OccupancyEstado;
  truncated?: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const days: string[] = Array.from({ length: dias }, (_, i) => addDays(desde, i));
  const byScreen = new Map<string, ScreenConflict[]>();
  for (const c of conflicts) {
    const list = byScreen.get(c.screen_id) ?? [];
    list.push(c);
    byScreen.set(c.screen_id, list);
  }
  const covers = (list: ScreenConflict[], day: string): ScreenConflict | null =>
    list.find((r) => r.starts <= day && day <= r.ends) ?? null;

  // Ocupada = ≥1 día rojo en la ventana visible (tiene algo vendido);
  // libre = 0 días ocupados (hueco total, lo que busca un comprador).
  const busyDays = new Map<string, number>();
  for (const s of screens) {
    const list = byScreen.get(s.id) ?? [];
    let n = 0;
    for (const d of days) if (covers(list, d)) n += 1;
    busyDays.set(s.id, n);
  }
  const visibles =
    estado === "all" ? screens : screens.filter((s) => (estado === "ocupada" ? (busyDays.get(s.id) ?? 0) > 0 : (busyDays.get(s.id) ?? 0) === 0));

  let busyCells = 0;
  for (const s of visibles) busyCells += busyDays.get(s.id) ?? 0;
  const totalCells = visibles.length * days.length;
  const occPct = totalCells > 0 ? Math.round((busyCells / totalCells) * 100) : 0;

  const go = (patch: { desde?: string; dias?: number; q?: string; ciudad?: string | null; proveedor?: string | null; estado?: string }) => {
    const params = new URLSearchParams();
    const store = sp.get("store");
    if (store) params.set("store", store);
    const nq = patch.q !== undefined ? patch.q : q;
    const nc = patch.ciudad !== undefined ? patch.ciudad : ciudad;
    const np = patch.proveedor !== undefined ? patch.proveedor : supplierValue;
    const ne = patch.estado !== undefined ? patch.estado : estado;
    const nd = patch.desde ?? desde;
    const ndias = patch.dias ?? dias;
    if (nq.trim()) params.set("q", nq.trim());
    if (nc) params.set("ciudad", nc);
    // "all" se persiste explícito (?proveedor=all); omitirlo rebotaba al
    // default de la empresa y hacía imposible ver todo proveedor.
    if (np) params.set("proveedor", np);
    if (ne && ne !== "all") params.set("estado", ne);
    if (ndias !== 14) params.set("dias", String(ndias));
    const today = todayLima();
    if (nd !== today) params.set("desde", nd);
    startTransition(() => {
      router.replace(`/occupancy${params.toString() ? `?${params.toString()}` : ""}`);
    });
  };

  const shift = (n: number) => go({ desde: addDays(desde, n) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filtros de ocupación">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar pantalla, distrito, ciudad, proveedor o código…"
          ariaLabel="Buscar pantallas"
          onSearch={(value) => go({ q: value })}
        />
        <FilterSelect
          value={supplierValue}
          onChange={(v) => go({ proveedor: v })}
          ariaLabel="Filtrar por proveedor"
          placeholder="Proveedor"
          display={(value) =>
            value === "all"
              ? "Todo proveedor"
              : value === "own"
                ? (casaName ? `Red propia · ${casaName}` : "Red propia")
                : (suppliers.find((s) => s.id === value)?.name ?? "Proveedor")
          }
        >
          <SelectItem value="all">Todo proveedor</SelectItem>
          {casaName && <SelectItem value="own">{`Red propia · ${casaName}`}</SelectItem>}
          {suppliers.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect
          value={ciudad ?? "all"}
          onChange={(v) => go({ ciudad: v === "all" ? null : v })}
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
          value={estado}
          onChange={(v) => go({ estado: v })}
          ariaLabel="Filtrar por estado"
          placeholder="Estado"
          display={(value) =>
            value === "all" ? "Todas" : value === "libre" ? "Libres" : value === "ocupada" ? "Ocupadas" : String(value)
          }
        >
          <SelectItem value="all">Todas</SelectItem>
          <SelectItem value="libre">Libres</SelectItem>
          <SelectItem value="ocupada">Ocupadas</SelectItem>
        </FilterSelect>
        <SegmentedControl
          options={[{ value: 7, label: "7d" }, { value: 14, label: "14d" }, { value: 28, label: "28d" }]}
          value={dias}
          onChange={(n) => go({ dias: n })}
          disabled={isPending}
          ariaLabel="Días visibles"
        />
        <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => shift(-dias)}>
          ←
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => shift(dias)}>
          →
        </Button>
        <span className="ms-auto text-xs text-muted-foreground tabular-nums" role="status" aria-live="polite">
          {isPending
            ? "Buscando…"
            : `${formatNumber(visibles.length)} pantallas · ${occPct}% ocupado${truncated ? " · muestra parcial" : ""}`}
        </span>
      </div>

      <AppCard variant="table">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                <th className="sticky left-0 z-10 min-w-[220px] bg-muted px-3 py-2 font-medium">Pantalla</th>
                {days.map((d) => (
                  <th key={d} className="min-w-[44px] px-1 py-2 text-center font-medium tabular-nums">
                    {formatDayMonth(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibles.map((s) => {
                const list = byScreen.get(s.id) ?? [];
                return (
                  <tr
                    key={s.id}
                    tabIndex={0}
                    role="button"
                    aria-label={`Abrir pantalla ${s.name}`}
                    onClick={() => setSelectedId(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(s.id);
                      }
                    }}
                    className="cursor-pointer border-b last:border-0 hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <td className="sticky left-0 z-10 bg-background px-3 py-2">
                      <span className="font-medium">{s.name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {[s.venue_name, s.city].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </td>
                    {days.map((d) => {
                      const hit = covers(list, d);
                      return (
                        <td key={d} className="px-1 py-1 text-center">
                          <span
                            title={
                              hit
                                ? `Ocupado · ${[hit.io_number, hit.brand].filter(Boolean).join(" · ") || hit.source}`
                                : `Libre · ${d}`
                            }
                            aria-label={hit ? `Ocupado ${d}` : `Libre ${d}`}
                            className={
                              hit
                                ? "mx-auto block size-5 rounded-sm bg-rose-500/70"
                                : "mx-auto block size-5 rounded-sm bg-emerald-500/20"
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AppCard>

      {visibles.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {estado === "libre"
            ? "Nada libre en esa ventana con esos filtros. Prueba más días u otro proveedor."
            : estado === "ocupada"
              ? "Nada ocupado en esa ventana con esos filtros. Todo libre."
              : "Sin pantallas para esos filtros. Ajusta la búsqueda, el proveedor o la ciudad."}
        </p>
      )}

      <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <CalendarDays className="size-3.5" aria-hidden />
        <span className="mr-1 inline-block size-2.5 rounded-sm bg-rose-500/70 align-middle" aria-hidden />
        ocupado (pasa el cursor para ver IO/marca)
        <span className="ml-2 mr-1 inline-block size-2.5 rounded-sm bg-emerald-500/20 align-middle" aria-hidden />
        libre · el borrador aparta 7 días, vencido libera solo.
      </p>

      {selectedId && <PantallaDrawer screenId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
