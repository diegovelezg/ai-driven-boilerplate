"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { RankedItem } from "@/lib/finance";
import { formatMoney } from "@/lib/medusa";

const INITIAL_VISIBLE = 5;

function RankingCard({
  title,
  items,
  currency,
}: {
  title: string;
  items: RankedItem[];
  currency: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, INITIAL_VISIBLE);
  const hiddenCount = items.length - INITIAL_VISIBLE;
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {visible.map((it) => (
          <div
            key={it.title}
            className="flex items-baseline justify-between gap-2 rounded px-1 py-0.5 text-[13px]"
          >
            <span className="truncate">{it.title}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {it.quantity} uds · {it.orders} {it.orders === 1 ? "pedido" : "pedidos"} ·{" "}
              <strong className="text-foreground">{formatMoney(it.revenueMinor, currency)}</strong>
            </span>
          </div>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 cursor-pointer self-start px-1 text-[13px] font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {expanded ? "Ver menos" : `Ver más... (${hiddenCount} más)`}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

export function ItemsRanking({
  top,
  bottom,
  currency,
}: {
  top: RankedItem[];
  bottom: RankedItem[];
  currency: string | null;
}) {
  if (top.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <RankingCard title="Lo que más vende · 12m" items={top} currency={currency} />
      {bottom.length > 0 && (
        <RankingCard title="Lo que menos vende · 12m" items={bottom} currency={currency} />
      )}
    </div>
  );
}
