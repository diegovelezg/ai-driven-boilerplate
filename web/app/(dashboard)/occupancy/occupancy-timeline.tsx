"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { CalendarDays } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { FilterSearch } from "@/components/filter-search";
import { FilterSelect, SelectItem } from "@/components/filter-select";
import { formatNumber } from "@/lib/format";
import { PantallaDrawer } from "../screens/pantalla-drawer";
import type { ScreenConflict } from "@/lib/availability";

export interface OccupancyScreen {
  id: string;
  name: string;
  city: string | null;
  venue_name: string | null;
}

function toNum(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function toDay(num: number): string {
  const d = new Date(num * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function shortDay(day: string): string {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

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
  truncated?: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const days: string[] = Array.from({ length: dias }, (_, i) => toDay(toNum(desde) + i));
  const byScreen = new Map<string, ScreenConflict[]>();
  for (const c of conflicts) {
    const list = byScreen.get(c.screen_id) ?? [];
    list.push(c);
    byScreen.set(c.screen_id, list);
  }
  const covers = (list: ScreenConflict[], day: string): ScreenConflict | null =>
    list.find((r) => r.starts <= day && day <= r.ends) ?? null;

  let busyCells = 0;
  for (const s of screens) {
    const list = byScreen.get(s.id) ?? [];
    for (const d of days) if (covers(list, d)) busyCells += 1;
  }
  const totalCells = screens.length * days.length;
  const occPct = totalCells > 0 ? Math.round((busyCells / totalCells) * 100) : 0;

  const go = (patch: { desde?: string; dias?: number; q?: string; ciudad?: string | null; proveedor?: string | null }) => {
    const params = new URLSearchParams();
    const store = sp.get("store");
    if (store) params.set("store", store);
    const nq = patch.q !== undefined ? patch.q : q;
    const nc = patch.ciudad !== undefined ? patch.ciudad : ciudad;
    const np = patch.proveedor !== undefined ? patch.proveedor : supplierValue;
    const nd = patch.desde ?? desde;
    const ndias = patch.dias ?? dias;
    if (nq.trim()) params.set("q", nq.trim());
    if (nc) params.set("ciudad", nc);
    if (np && np !== "all") params.set("proveedor", np);
    if (ndias !== 14) params.set("dias", String(ndias));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    if (nd !== today) params.set("desde", nd);
    startTransition(() => {
      router.replace(`/occupancy${params.toString() ? `?${params.toString()}` : ""}`);
    });
  };

  const shift = (n: number) => go({ desde: toDay(toNum(desde) + n) });

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
        {[7, 14, 28].map((n) => (
          <Button
            key={n}
            type="button"
            variant={dias === n ? "default" : "outline"}
            size="sm"
            disabled={isPending}
            onClick={() => go({ dias: n })}
          >
            {n}d
          </Button>
        ))}
        <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => shift(-dias)}>
          ←
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => shift(dias)}>
          →
        </Button>
        <span className="ms-auto text-xs text-muted-foreground tabular-nums" role="status" aria-live="polite">
          {isPending
            ? "Buscando…"
            : `${formatNumber(screens.length)} pantallas · ${occPct}% ocupado${truncated ? " · muestra parcial" : ""}`}
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
                    {shortDay(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {screens.map((s) => {
                const list = byScreen.get(s.id) ?? [];
                return (
                  <tr key={s.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background px-3 py-2">
                      <button
                        type="button"
                        className="font-medium hover:underline"
                        onClick={() => setSelectedId(s.id)}
                      >
                        {s.name}
                      </button>
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

      {screens.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Sin pantallas para esos filtros. Ajusta la búsqueda, el proveedor o la ciudad.
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
