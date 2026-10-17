"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { EditableCustomer } from "@/lib/customers-db";
import { formatMoney } from "@/lib/medusa";
import { CustomerDrawer } from "../customers/customer-drawer";

export function TopCustomers({
  rows,
  currency,
}: {
  rows: Array<{ customer: EditableCustomer; revenueMinor: number; orders: number }>;
  currency: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((r) => r.customer.dbId === selectedId)?.customer ?? null;
  if (rows.length === 0) return null;
  return (
    <section aria-label="Mejores clientes">
      <Card>
        <CardContent className="flex flex-col gap-2 p-4">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Mejores clientes · 12m
          </span>
          {rows.map(({ customer, revenueMinor, orders }) => {
            const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
            return (
              <button
                key={customer.dbId}
                type="button"
                onClick={() => setSelectedId(customer.dbId)}
                className="flex cursor-pointer items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left text-[13px] transition-colors hover:bg-muted"
              >
                <span className="truncate">
                  {name || "Sin nombre"}
                  <span className="ml-2 text-xs text-muted-foreground">{customer.email}</span>
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {orders} {orders === 1 ? "pedido" : "pedidos"} ·{" "}
                  <strong className="text-foreground">{formatMoney(revenueMinor, currency)}</strong>
                </span>
              </button>
            );
          })}
        </CardContent>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        Por revenue en los últimos 12 meses, en {(currency ?? "PEN").toUpperCase()}. Clic para ver la
        ficha. Cuídalos: son tu base.
      </p>
      {selected && (
        <CustomerDrawer
          key={selected.dbId}
          customer={selected}
          initialTab="compras"
          onClose={() => setSelectedId(null)}
        />
      )}
    </section>
  );
}
