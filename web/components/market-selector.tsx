"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { displayMarket, type TenantMarket } from "@/lib/markets";

/**
 * Filtro global por país/mercado (?market= en URL, como ?store=).
 * Solo visible si la tienda activa tiene 2+ markets; con uno no filtra nada.
 * Al cambiar: preserva el resto de params, resetea `page`.
 */
export function MarketSelector({
  stores,
  marketsByStore,
}: {
  stores: Array<{ id: string }>;
  marketsByStore: Record<string, TenantMarket[]>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  // Activa igual que lib/tenant en servidor (?store= válido > primera);
  // el fallback legacy solo existe en servidor (tienda única: coincide).
  const param = sp.get("store");
  const activeId = stores.some((s) => s.id === param) ? (param as string) : (stores[0]?.id ?? null);
  const markets: TenantMarket[] = (activeId && marketsByStore[activeId]) || [];
  if (markets.length < 2) return null;

  const raw = sp.get("market");
  const value = raw && markets.some((m) => m.id === raw) ? raw : "all";

  const onChange = (v: string | null) => {
    if (!v) return;
    const next = new URLSearchParams(sp.toString());
    if (v === "all") next.delete("market");
    else next.set("market", v);
    next.delete("page");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-40" aria-label="Filtrar por país">
        <SelectValue placeholder="Todos los países" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Todos los países</SelectItem>
        {markets.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {displayMarket(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
