"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { formatMoney, formatNumber } from "@/lib/format";
import { setProductActiveAction } from "@/lib/products-actions";
import type { ProductWithStats } from "@/lib/product-stats";

function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return "—";
  const meses = [
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
  ];
  return `${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;
}

export function ProductsList({ storeId, rows, total, truncated }: { storeId: string; rows: ProductWithStats[]; total: number; truncated: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (productId: string, active: boolean | null) => {
    setBusy(productId);
    const r = await setProductActiveAction(storeId, productId, active);
    setBusy(null);
    if (!r.ok) {
      toast.add({ title: "No se pudo actualizar", description: r.message, type: "error" });
    } else {
      toast.add({ title: "Catálogo actualizado", description: r.message, type: "success" });
      router.refresh();
    }
  };

  const nActive = rows.filter((r) => r.is_active).length;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {formatNumber(nActive)} activos · {formatNumber(rows.length - nActive)} inactivos ·{" "}
        {formatNumber(total)} en catálogo{truncated ? ` (mostrando ${formatNumber(rows.length)})` : ""}.
        Sin movimiento = sin cifras.
      </p>
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">Sin ítems con este filtro.</p>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Ítem</th>
              <th className="px-3 py-2 font-medium">Estado</th>
              <th className="px-3 py-2 text-right font-medium">Cant.</th>
              <th className="px-3 py-2 text-right font-medium">Monto</th>
              <th className="px-3 py-2 text-right font-medium">30d</th>
              <th className="px-3 py-2 text-right font-medium">Actividad</th>
              <th className="px-3 py-2 text-right font-medium">Acción</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <span className="font-medium">{r.title}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {r.platform_status ?? "—"}
                    {r.is_active_override !== null && " · manual"}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={
                      r.is_active
                        ? "inline-block rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600"
                        : "inline-block rounded-full bg-zinc-500/15 px-2 py-0.5 text-xs text-zinc-500"
                    }
                  >
                    {r.is_active ? "activo" : "inactivo"}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.qty_all)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.currency ? formatMoney(r.revenue_all, r.currency) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.qty_30d)}</td>
                <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                  {fechaCorta(r.last_sold_at)}
                </td>
                <td className="px-3 py-2 text-right">
                  <span className="inline-flex gap-1">
                    {r.is_active ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy === r.id}
                        onClick={() => act(r.id, false)}
                      >
                        Desactivar
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy === r.id}
                        onClick={() => act(r.id, true)}
                      >
                        Activar
                      </Button>
                    )}
                    {r.is_active_override !== null && (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy === r.id}
                        onClick={() => act(r.id, null)}
                        title="Volver a seguir a la plataforma"
                      >
                        Auto
                      </Button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
