"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { FilterSelect, SelectItem } from "@/components/filter-select";
import { displayMarket, type TenantMarket } from "@/lib/market-utils";

/**
 * Filtro global por país/mercado (?market= en URL, como ?store=).
 * Solo visible si la tienda activa tiene 2+ markets; con uno no filtra nada.
 * Sin "todos": mezclar monedas confunde; el default es el mercado primario
 * (moneda de la tienda). Al cambiar: preserva el resto de params, resetea `page`.
 * Persiste por tienda en localStorage (`retain.market.<storeId>`): al volver
 * a una ruta sin ?market= se restaura, y al navegar se conserva.
 */
export function MarketSelector({
  stores,
  marketsByStore,
  primaryByStore = {},
}: {
  stores: Array<{ id: string }>;
  marketsByStore: Record<string, TenantMarket[]>;
  primaryByStore?: Record<string, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  // Activa igual que lib/tenant en servidor (?store= válido > primera).
  const param = sp.get("store");
  const activeId = stores.some((s) => s.id === param) ? (param as string) : (stores[0]?.id ?? null);
  const markets: TenantMarket[] = (activeId && marketsByStore[activeId]) || [];
  const primaryId = (activeId && primaryByStore[activeId]) || markets[0]?.id || null;
  const raw = sp.get("market");
  const value = (raw && markets.some((m) => m.id === raw) ? raw : primaryId) ?? markets[0]?.id ?? "";

  // Restaura la selección persistida si la URL viene sin ?market=
  // (navegación directa, bookmark, o link sin params). Solo si el id
  // guardado sigue siendo un market válido de la tienda activa.
  useEffect(() => {
    if (!activeId || raw || markets.length < 2) return;
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(`retain.market.${activeId}`);
    } catch {
      saved = null;
    }
    if (saved && saved !== primaryId && markets.some((m) => m.id === saved)) {
      const next = new URLSearchParams(sp.toString());
      next.set("market", saved);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    } else if (!raw && primaryId) {
      // Sin selección: fija el primario en la URL para que servidor y
      // cliente vean lo mismo (nunca "todos" implícito).
      const next = new URLSearchParams(sp.toString());
      next.set("market", primaryId);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }
    // Solo al resolver tienda/markets o al limpiar ?market= de la URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, raw, pathname]);

  if (markets.length < 2) return null;

  // Base UI resuelve <Select.Value> contra `items` cuando el popup (Portal)
  // aún no montó los <SelectItem>: sin esto el trigger muestra el UUID crudo
  // en lugar de la etiqueta humana.
  const items: Record<string, ReactNode> = {};
  for (const m of markets) items[m.id] = displayMarket(m);

  const onChange = (v: string | null) => {
    if (!v) return;
    try {
      if (activeId) window.localStorage.setItem(`retain.market.${activeId}`, v);
    } catch {
      // localStorage no disponible: el filtro sigue funcionando por URL
    }
    const next = new URLSearchParams(sp.toString());
    next.set("market", v);
    next.delete("page");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <FilterSelect value={value} onChange={onChange} items={items} ariaLabel="Filtrar por país" widthClass="w-40" placeholder="Mercado">
      {markets.map((m) => (
        <SelectItem key={m.id} value={m.id}>
          {displayMarket(m)}
        </SelectItem>
      ))}
    </FilterSelect>
  );
}
