"use client";

import { ArrowRight, CalendarDays, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RowIconButton } from "@/components/buttons";
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableRow,
  DataTableTd,
  DataTableTh,
} from "@/components/data-table";
import { SectionHeading } from "@/components/section-heading";
import { Money } from "@/components/money";
import { cn } from "cn";
import { addDays, formatDate, formatNumber } from "@/lib/format";
import type { ScreenConflict } from "@/lib/availability";
import { parseSlotsInput } from "@/lib/order-lines";
import type { ScreenPick } from "./types";
import { plural } from "./types";

/** Tabla de pantallas ya agregadas: precio/día y slots editables, días, subtotal.
 *  Subtotal = precio/día × días × slots (default 1 slot por línea).
 *  SSOT: misma pieza en nueva orden y en editar pantallas (drawer). */
export function OrderScreensTable({
  rows,
  prices,
  slots,
  dias,
  currency,
  occupiedOf,
  remainingOf,
  capacityOf,
  checking,
  commonWindow,
  onApplyWindow,
  onPriceChange,
  onSlotsChange,
  onRemove,
  onCalendar,
  onDetail,
  disabled,
  pending,
}: {
  rows: ScreenPick[];
  prices: Record<string, string>;
  slots: Record<string, string>;
  dias: number | null;
  currency: string;
  occupiedOf: (id: string) => ScreenConflict[];
  remainingOf: (id: string) => number | null;
  capacityOf: (id: string) => number | null;
  checking: boolean;
  commonWindow: string | null;
  onApplyWindow: (() => void) | null;
  onPriceChange: (id: string, value: string) => void;
  onSlotsChange: (id: string, value: string) => void;
  onRemove: (id: string) => void;
  onCalendar: (id: string) => void;
  onDetail: (id: string) => void;
  disabled?: boolean;
  pending?: boolean;
}) {
  const priceOf = (id: string) => {
    const n = Number(String(prices[id] ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const slotsOf = (id: string) => parseSlotsInput(slots[id]);
  const lineTotalOf = (id: string) => {
    const unit = priceOf(id);
    const qty = slotsOf(id);
    return unit !== null && qty !== null && dias !== null ? unit * dias * qty : 0;
  };
  const total = rows.reduce((a, r) => a + lineTotalOf(r.id), 0);
  const blockedRows = rows.filter((r) => occupiedOf(r.id).length > 0);

  return (
    <section className="flex flex-col gap-2" aria-label="Detalle por pantalla">
      <SectionHeading title="Detalle por pantalla" hint={`Precio por día × ${dias !== null ? `${formatNumber(dias)} días` : "días del periodo"} × slots.`} />
      {blockedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-destructive/5 px-2.5 py-2">
          <p className="text-xs text-destructive">
            {blockedRows.length} sin cupo{blockedRows.length > 1 ? "s" : ""} en ese periodo.
          </p>
          {dias !== null && (commonWindow && onApplyWindow ? (
            <Button type="button" size="xs" variant="outline" onClick={onApplyWindow}>
              <ArrowRight aria-hidden />
              Mover al próximo hueco: {formatDate(commonWindow)} → {formatDate(addDays(commonWindow, dias - 1))}
            </Button>
          ) : checking ? (
            <span className="text-xs text-muted-foreground">Buscando hueco común…</span>
          ) : (
            <span className="text-xs text-muted-foreground">Sin hueco común libre en 12 meses.</span>
          ))}
        </div>
      )}
      <DataTable>
        <DataTableHeader>
          <DataTableTh>Pantalla</DataTableTh>
          <DataTableTh numeric>Precio/día * ({currency})</DataTableTh>
          <DataTableTh numeric>Días</DataTableTh>
          <DataTableTh numeric>Slots</DataTableTh>
          <DataTableTh numeric>Subtotal ({currency})</DataTableTh>
          <DataTableTh aria-label="Acciones" />
        </DataTableHeader>
        <DataTableBody>
          {rows.map((s) => {
            const hits = occupiedOf(s.id);
            const free = remainingOf(s.id);
            const cap = capacityOf(s.id);
            const blockedLabel = (() => {
              if (hits.length === 0) return null;
              const who = [hits[0].io_number, hits[0].brand].filter(Boolean).join(" · ");
              const days = (hits[0].blockedDays ?? []).map((d) => formatDate(d)).join(", ");
              const rest = free !== null && free > 0 && cap !== null ? `quedan ${formatNumber(free)} de ${formatNumber(cap)} slots · ` : "";
              return `${free !== null && free > 0 ? "Parcial" : "Llena"} · ${rest}${who || "otro periodo"}${days ? ` (${days})` : ""} — quítala o cambia fechas`;
            })();
            return (
              <DataTableRow
                key={s.id}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("input,button")) return;
                  onDetail(s.id);
                }}
                className={cn(hits.length > 0 && "bg-destructive/5", "cursor-pointer")}
              >
                <DataTableTd className="font-medium" title={s.detail ?? undefined}>
                  {s.name}
                  {blockedLabel && (
                    <span className="block text-xs font-normal text-destructive">
                      {blockedLabel}
                    </span>
                  )}
                </DataTableTd>
                <DataTableTd numeric>
                  <Input
                    value={prices[s.id] ?? ""}
                    onChange={(e) => onPriceChange(s.id, e.target.value)}
                    disabled={disabled || pending || hits.length > 0}
                    inputMode="decimal"
                    placeholder={s.price_pen !== null && Number.isFinite(Number(s.price_pen)) ? String(s.price_pen) : "2000"}
                    aria-label={`Precio por día ${s.name}`}
                    className="w-28 text-right tabular-nums"
                  />
                </DataTableTd>
                <DataTableTd numeric className="tabular-nums">
                  {dias ?? "—"}
                </DataTableTd>
                <DataTableTd numeric>
                  <Input
                    value={slots[s.id] ?? "1"}
                    onChange={(e) => {
                      // Solo enteros: cualquier otro caracter se ignora (sin
                      // validación nativa, ver default de forms).
                      if (/^\d{0,3}$/.test(e.target.value)) onSlotsChange(s.id, e.target.value);
                    }}
                    disabled={disabled || pending || (hits.length > 0 && (free ?? 0) <= 0)}
                    inputMode="numeric"
                    placeholder="1"
                    aria-label={`Slots ${s.name}`}
                    className="w-20 text-right tabular-nums"
                  />
                </DataTableTd>
                <DataTableTd numeric className="tabular-nums">
                  {dias !== null && priceOf(s.id) !== null && slotsOf(s.id) !== null
                    ? <Money amountMinor={Math.round((priceOf(s.id) as number) * (dias as number) * (slotsOf(s.id) as number) * 100)} currency={currency} />
                    : "—"}
                </DataTableTd>
                <DataTableTd className="w-20">
                  <div className="flex items-center justify-end gap-1">
                    <RowIconButton
                      icon={CalendarDays}
                      label={`Ver disponibilidad de ${s.name}`}
                      disabled={disabled || pending}
                      pending={pending}
                      onClick={() => onCalendar(s.id)}
                    />
                    <RowIconButton
                      icon={X}
                      label={`Quitar ${s.name}`}
                      disabled={disabled || pending}
                      pending={pending}
                      onClick={() => onRemove(s.id)}
                    />
                  </div>
                </DataTableTd>
              </DataTableRow>
            );
          })}
          <DataTableRow className="bg-muted/30 font-medium">
            <DataTableTd colSpan={4}>
              Total · {formatNumber(rows.length)} pantalla{plural(rows.length)}
              {dias !== null ? ` × ${formatNumber(dias)} días` : ""}
            </DataTableTd>
            <DataTableTd numeric className="tabular-nums whitespace-nowrap">
              {total > 0 ? <Money amountMinor={Math.round(total * 100)} currency={currency} /> : "—"}
            </DataTableTd>
            <DataTableTd />
          </DataTableRow>
        </DataTableBody>
      </DataTable>
    </section>
  );
}
