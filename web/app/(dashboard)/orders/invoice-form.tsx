"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { Building2, CalendarIcon, Receipt, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CancelButton, RowIconButton, SubmitButton } from "@/components/buttons";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createInvoiceAction } from "@/lib/order-flow-actions";
import { todayLima, addDays } from "@/lib/availability-utils";
import { formatDate, formatMoney, parseISODate, toISODateLocal } from "@/lib/format";
import { cn } from "cn";
import { taxIdLabel } from "@/lib/tax-id";
import { es } from "react-day-picker/locale";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";
import {
  billingBlocker,
  invoiceFieldsFromMessage,
  minorToAmountInput,
  parseWholeAmountToMinor,
  suggestedInvoiceAmount,
  validateInvoiceFields,
  type InvoiceFieldKey,
} from "./invoice-validation";
import { splitTax } from "@/lib/tax-rate";

/** Date picker shadcn (Popover + Calendar, mismo patrón que nueva-form):
 *  fecha válida o vacía (con X para limpiar), nunca texto libre. */
export function InvoiceDatePicker({
  label,
  fieldKey,
  value,
  onChange,
  disabled,
  invalid,
  disabledDays,
  pickerLabel,
}: {
  label: string;
  fieldKey: "issue" | "due" | "date";
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  disabledDays?: (date: Date) => boolean;
  pickerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseISODate(value);

  return (
    <div className="grid min-w-0 content-start gap-1.5 text-xs">
      <Label htmlFor={`inv-${fieldKey}`}>{label}</Label>
      <div className="flex gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                id={`inv-${fieldKey}`}
                aria-label={pickerLabel}
                aria-invalid={invalid}
                data-field={fieldKey}
                className={cn(
                  "h-9 min-w-0 flex-1 justify-start bg-background px-2.5 text-sm font-normal tabular-nums",
                  !selected && "text-muted-foreground",
                  invalid && "border-destructive ring-2 ring-destructive/30",
                )}
              >
                <CalendarIcon aria-hidden />
                {selected ? formatDate(value) : "Elegir…"}
              </Button>
            }
          />
          <PopoverContent align="start" className="w-auto p-0">
            <Calendar
              mode="single"
              locale={es}
              selected={selected}
              disabled={disabledDays}
              onSelect={(d) => {
                if (d) {
                  onChange(toISODateLocal(d));
                  setOpen(false);
                }
              }}
            />
          </PopoverContent>
        </Popover>
        {selected && (
          <RowIconButton
            icon={X}
            label={`Limpiar ${pickerLabel}`}
            title="Limpiar fecha"
            disabled={disabled}
            onClick={() => onChange("")}
          />
        )}
      </div>
    </div>
  );
}

/** Registra una factura emitida (dialog del drawer, tab Cobranza).
 *  Moneda = la de la orden (solo lectura): el servidor la hereda y el
 *  trigger de paridad aborta cualquier mezcla. El bruto nace sugerido
 *  (bruto o remanente); el IGV/IVA se calcula y el total es lo que se
 *  registra. */
export function InvoiceForm({
  orderId,
  orderCurrency,
  paymentTermsDays,
  onSaved,
  onCancel,
  billingName,
  billingTaxId,
  billingCountry,
  grossMinor,
  invoicedMinor,
  taxCountry,
}: {
  orderId: string;
  orderCurrency: string;
  paymentTermsDays: number | null;
  billingName: string | null;
  billingTaxId: string | null;
  billingCountry?: string | null;
  /** Bruto de la orden en minor SIN impuesto (suma de líneas). */
  grossMinor?: number;
  /** Ya facturado activo en minor (issued/paid/overdue, sin canceladas). */
  invoicedMinor?: number;
  /** País del tenant para la tasa (SSOT `lib/tax-rate.ts`). */
  taxCountry?: string | null;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const issue0 = todayLima();
  const suggestion = useMemo(
    () => suggestedInvoiceAmount(grossMinor ?? 0, invoicedMinor ?? 0, taxCountry ?? null),
    [grossMinor, invoicedMinor, taxCountry],
  );
  const suggestedInput = suggestion.suggestedMinor !== null ? minorToAmountInput(suggestion.netMinor) : "";
  const [number, setNumber] = useState("");
  const [bruto, setBruto] = useState(suggestedInput);
  const [issue, setIssue] = useState(issue0);
  const [due, setDue] = useState(
    typeof paymentTermsDays === "number" && paymentTermsDays >= 0 ? addDays(issue0, paymentTermsDays) : "",
  );
  const status = "issued";
  const [pending, startTransition] = useTransition();
  const { invalid, mark, clear, bad, focusFirst } = useInvalidFields<InvoiceFieldKey>();
  const formRef = useRef<HTMLFormElement>(null);

  const missing: string[] = [];
  if (!number.trim()) missing.push("número");
  if (!bruto.trim()) missing.push("bruto");

  // Desglose vivo sin decimales: bruto entero + impuesto calculado =
  // total redondeado a registrar. El impuesto mostrado cuadra exacto
  // (total − bruto) para que las filas siempre sumen.
  const brutoMinor = parseWholeAmountToMinor(bruto);
  const split = splitTax(brutoMinor ?? 0, taxCountry ?? null);
  const totalMinor = brutoMinor !== null ? Math.round(split.total / 100) * 100 : null;
  const taxShownMinor = totalMinor !== null && brutoMinor !== null ? totalMinor - brutoMinor : null;

  const blocked = billingBlocker({ name: billingName, taxId: billingTaxId, country: billingCountry });

  function save() {
    if (blocked) {
      toastFormError("No se puede facturar", blocked);
      return;
    }
    const problems = validateInvoiceFields({ number, amount: bruto, issue, due, status });
    if (problems.length > 0) {
      const keys = [...new Set(problems.map((p) => p.key))];
      mark(keys);
      toastFormError("Revisa los campos marcados", problems.map((p) => p.message).join(" "));
      focusFirst(formRef, keys);
      return;
    }
    if (totalMinor === null) {
      mark(["amount"]);
      toastFormError("Revisa los campos marcados", "Monto inválido: número entero > 0, sin decimales.");
      focusFirst(formRef, ["amount"]);
      return;
    }
    startTransition(async () => {
      const res = await createInvoiceAction({
        orderId,
        number: number.trim(),
        amountMinor: totalMinor,
        issueDate: issue.trim() || null,
        dueDate: due.trim() || null,
        status,
      });
      if (!res.ok) {
        const keys = invoiceFieldsFromMessage(res.message);
        if (keys.length > 0) {
          mark(keys);
          focusFirst(formRef, keys);
        }
        toastFormError("No se pudo registrar", res.message);
        return;
      }
      onSaved?.();
    });
  }

  return (
    <form
      ref={formRef}
      noValidate
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div
        className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 ${blocked ? "border-destructive/40 bg-destructive/5" : "border-border/60 bg-muted/40"}`}
        aria-label="Empresa a facturar"
      >
        <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${blocked ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}`}>
          <Building2 className="size-4" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Facturar a
          </span>
          {blocked ? (
            <span className="mt-1 block text-[13px] font-medium text-destructive">{blocked}</span>
          ) : (
            <>
              <span className="mt-0.5 block break-words text-sm font-semibold">{billingName}</span>
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="rounded-md border border-border/60 bg-background px-1.5 py-0.5 font-medium tabular-nums">
                  {taxIdLabel(billingCountry)} {billingTaxId}
                </span>
                <span className="rounded-md border border-border/60 bg-background px-1.5 py-0.5 font-medium">
                  {orderCurrency}
                </span>
              </span>
            </>
          )}
        </span>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="inv-number">Número de factura *</Label>
        <Input
          id="inv-number"
          name="number"
          value={number}
          onChange={(e) => { setNumber(e.target.value); clear("number"); }}
          placeholder="F001-123"
          maxLength={60}
          disabled={pending}
          aria-invalid={invalid.has("number")}
          aria-describedby="inv-number-hint"
          className={bad("number").trim() ? `font-medium tracking-wide${bad("number")}` : "font-medium tracking-wide"}
        />
        <p id="inv-number-hint" className="text-xs text-muted-foreground">
          Serie y número del comprobante (ej F001-123).
        </p>
      </div>
      <div className="grid gap-1.5" aria-label="Desglose del comprobante">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <Label htmlFor="inv-amount">Bruto ({orderCurrency}) *</Label>
          <Input
            id="inv-amount"
            name="amount"
            value={bruto}
            onChange={(e) => { setBruto(e.target.value); clear("amount"); }}
            placeholder="5,000"
            inputMode="numeric"
            disabled={pending}
            aria-invalid={invalid.has("amount")}
            aria-describedby="inv-amount-hint"
            className={bad("amount").trim() ? `w-44 text-right text-base tabular-nums${bad("amount")}` : "w-44 text-right text-base tabular-nums"}
          />
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 text-sm">
          <span className="text-muted-foreground">{suggestion.taxName} ({Math.round(suggestion.rate * 100)}%)</span>
          <output aria-label={`${suggestion.taxName} calculado`} className="w-44 px-3 py-1 text-right tabular-nums">
            {taxShownMinor !== null ? formatMoney(taxShownMinor, orderCurrency) : "—"}
          </output>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-border/60 pt-2 text-sm font-semibold">
          <span>Total a registrar</span>
          <output aria-label="Total a registrar" aria-live="polite" className="w-44 px-3 py-1 text-right tabular-nums">
            {totalMinor !== null ? formatMoney(totalMinor, orderCurrency) : "—"}
          </output>
        </div>
        <p id="inv-amount-hint" className="text-xs text-muted-foreground tabular-nums">
          {suggestion.suggestedMinor !== null ? (
            <>Sugerido: bruto {formatMoney(suggestion.netMinor, orderCurrency)}{(invoicedMinor ?? 0) > 0 ? ` (remanente: bruto ${formatMoney(grossMinor ?? 0, orderCurrency)} − ya facturado ${formatMoney(invoicedMinor ?? 0, orderCurrency)})` : ""}. Total con impuesto: {formatMoney(Math.round(suggestion.suggestedMinor / 100) * 100, orderCurrency)}.</>
          ) : (grossMinor ?? 0) > 0 ? (
            <>Orden ya facturada en su totalidad.</>
          ) : (
            <>Bruto sin decimales; el impuesto se suma al total.</>
          )}
        </p>
        {suggestedInput && bruto !== suggestedInput && (
          <div>
            <Button type="button" variant="ghost" size="xs" disabled={pending} onClick={() => { setBruto(suggestedInput); clear("amount"); }}>
              Usar sugerido {suggestedInput}
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <InvoiceDatePicker
          label="Emisión"
          fieldKey="issue"
          value={issue}
          onChange={(v) => { setIssue(v); clear("issue"); clear("due"); }}
          disabled={pending}
          invalid={invalid.has("issue")}
          disabledDays={due ? (d) => toISODateLocal(d) > due : undefined}
          pickerLabel="Fecha de emisión"
        />
        <InvoiceDatePicker
          label="Vencimiento"
          fieldKey="due"
          value={due}
          onChange={(v) => { setDue(v); clear("due"); }}
          disabled={pending}
          invalid={invalid.has("due")}
          disabledDays={issue ? (d) => toISODateLocal(d) < issue : undefined}
          pickerLabel="Fecha de vencimiento"
        />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-4">
        <CancelButton size="sm" onCancel={onCancel} disabled={pending} />
        <SubmitButton
          size="sm"
          pending={pending}
          disabled={blocked !== null || missing.length > 0}
          title={blocked ?? (missing.length > 0 ? `Falta: ${missing.join(" y ")}` : undefined)}
          pendingLabel="Registrando…"
        >
          <Receipt aria-hidden />
          {`Registrar factura${totalMinor ? ` · ${formatMoney(totalMinor, orderCurrency)}` : ""}`}
        </SubmitButton>
      </div>
    </form>
  );
}
