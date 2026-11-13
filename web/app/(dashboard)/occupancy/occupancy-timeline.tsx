"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "cn";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/buttons";
import { FilterSearch } from "@/components/filter-search";
import { FilterSelect, SelectItem } from "@/components/filter-select";
import { addDays, formatDate, formatDayMonth, formatNumber, todayLima } from "@/lib/format";
import { dayCellState, type DayCellState } from "@/lib/occupancy-cells";
import { DEFAULT_SLOTS_PER_SCREEN } from "@/lib/store-slots";
import { PantallaDrawer } from "../screens/pantalla-drawer";
import { OccupancyDayDrawer } from "./occupancy-day-drawer";
import type { PeriodAvailability } from "@/lib/availability";

export interface OccupancyScreen {
  id: string;
  name: string;
  city: string | null;
  venue_name: string | null;
}

export type OccupancyEstado = "all" | "libre" | "ocupada";

const CELL_TEXT: Record<DayCellState, string> = {
  free: "bg-emerald-500/15 text-emerald-700",
  low: "bg-sky-500/20 text-sky-900",
  high: "bg-amber-500/25 text-amber-900",
  full: "bg-rose-500/70 text-white",
  over: "bg-rose-700 text-white",
};

const CELL_FILL: Record<DayCellState, string> = {
  free: "bg-emerald-500/25",
  low: "bg-sky-500/60",
  high: "bg-amber-500/70",
  full: "bg-rose-500/70",
  over: "bg-rose-700",
};

export function OccupancyTimeline({
  screens,
  availability,
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
  availability: PeriodAvailability;
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
  const [selectedDay, setSelectedDay] = useState<{ screenId: string; screenName: string; day: string } | null>(null);

  const days: string[] = useMemo(() => Array.from({ length: dias }, (_, i) => addDays(desde, i)), [desde, dias]);
  const remaining = availability.remaining;
  const capacities = availability.capacities;
  const takenByDay = availability.taken;
  const holdSet = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const [id, ds] of Object.entries(availability.holds)) m.set(id, new Set(ds));
    return m;
  }, [availability.holds]);

  const takenOf = (screenId: string, day: string): { taken: number; cap: number } => {
    const cap = capacities[screenId] ?? DEFAULT_SLOTS_PER_SCREEN;
    const raw = takenByDay[screenId]?.[day];
    const takenN = raw ?? Math.max(0, cap - (remaining[screenId]?.[day] ?? cap));
    return { taken: Math.max(0, takenN), cap };
  };

  // Ocupada = ≥1 día con algo vendido; libre = 0 slots vendidos en la ventana.
  const soldDays = new Map<string, number>();
  for (const s of screens) {
    let n = 0;
    for (const d of days) if (takenOf(s.id, d).taken > 0) n += 1;
    soldDays.set(s.id, n);
  }
  const visibles =
    estado === "all" ? screens : screens.filter((s) => (estado === "ocupada" ? (soldDays.get(s.id) ?? 0) > 0 : (soldDays.get(s.id) ?? 0) === 0));

  let soldSlots = 0;
  let totalSlots = 0;
  for (const s of visibles) {
    const cap = capacities[s.id] ?? DEFAULT_SLOTS_PER_SCREEN;
    for (const d of days) {
      totalSlots += cap;
      soldSlots += takenOf(s.id, d).taken;
    }
  }
  const occPct = totalSlots > 0 ? Math.round((soldSlots / totalSlots) * 100) : 0;

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
            : `${formatNumber(visibles.length)} pantallas · ${occPct}% slots-día ocupados${truncated ? " · muestra parcial" : ""}`}
        </span>
      </div>

      <AppCard variant="table">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                <th className="sticky left-0 z-10 min-w-[220px] bg-muted px-3 py-2 font-medium">Pantalla</th>
                {days.map((d) => (
                  <th key={d} className="min-w-[56px] px-1 py-2 text-center font-medium tabular-nums">
                    {formatDayMonth(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibles.map((s) => (
                <tr
                  key={s.id}
                  className="border-b last:border-0 hover:bg-muted/30"
                >
                  <td className="sticky left-0 z-10 bg-background px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setSelectedId(s.id)}
                      className="block text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label={`Abrir ficha de ${s.name}`}
                      title={`Abrir ficha de ${s.name}`}
                    >
                      <span className="font-medium underline-offset-2 hover:underline">{s.name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {[s.venue_name, s.city].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </button>
                  </td>
                  {days.map((d) => {
                    const { taken, cap } = takenOf(s.id, d);
                    const state = dayCellState(taken, cap);
                    const pct = cap > 0 ? Math.round((Math.min(taken, cap) / cap) * 100) : taken > 0 ? 100 : 0;
                    const hold = holdSet.get(s.id)?.has(d) ?? false;
                    const label =
                      state === "free"
                        ? `Libre · ${formatDate(d)} (${cap} slots)`
                        : state === "over"
                          ? `Sobreventa · ${formatDate(d)}: ${taken}/${cap} slots — clic para desglose`
                          : `${state === "full" ? "Lleno" : "Parcial"} · ${formatDate(d)}: ${taken}/${cap} slots (${pct}%)${hold ? " · con hold" : ""} — clic para desglose`;
                    return (
                      <td key={d} className="px-1 py-1 text-center">
                        <button
                          type="button"
                          onClick={() => setSelectedDay({ screenId: s.id, screenName: s.name, day: d })}
                          title={label}
                          aria-label={`${s.name} ${label}`}
                          className={cn(
                            "relative mx-auto flex h-6 w-14 items-center justify-center overflow-hidden rounded-sm text-[10px] tabular-nums",
                            CELL_TEXT[state],
                          )}
                        >
                          <span
                            aria-hidden
                            className={cn("absolute inset-y-0 left-0", CELL_FILL[state])}
                            style={
                              state === "over"
                                ? {
                                    width: "100%",
                                    backgroundImage:
                                      "repeating-linear-gradient(45deg, transparent, transparent 3px, rgb(255 255 255 / 0.35) 3px, rgb(255 255 255 / 0.35) 5px)",
                                  }
                                : { width: `${pct}%` }
                            }
                          />
                          {state !== "free" && (
                            <span className="relative font-medium">
                              {taken}/{cap}
                            </span>
                          )}
                          {hold && (
                            <span
                              aria-hidden
                              title="Con hold/borrador"
                              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-sky-500 ring-1 ring-white/70"
                            />
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
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

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <CalendarDays className="size-3.5" aria-hidden />
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm bg-emerald-500/25 align-middle" aria-hidden />
          libre
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm bg-sky-500/60 align-middle" aria-hidden />
          parcial
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm bg-amber-500/70 align-middle" aria-hidden />
          casi lleno (80%+)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm bg-rose-500/70 align-middle" aria-hidden />
          lleno
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-1.5 rounded-full bg-sky-500 align-middle" aria-hidden />
          con hold
        </span>
        <span>Clic en la celda para el desglose · clic en el nombre para la ficha. El borrador aparta 7 días, vencido libera solo.</span>
      </p>

      {selectedId && <PantallaDrawer screenId={selectedId} onClose={() => setSelectedId(null)} />}
      {selectedDay && (
        <OccupancyDayDrawer
          key={`${selectedDay.screenId}-${selectedDay.day}`}
          screenId={selectedDay.screenId}
          screenName={selectedDay.screenName}
          day={selectedDay.day}
          onClose={() => setSelectedDay(null)}
        />
      )}
    </div>
  );
}
