"use client";

import { useRef, useState, useTransition } from "react";
import { Building2, CalendarIcon, Receipt, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createInvoiceAction } from "@/lib/order-flow-actions";
import { todayLima, addDays } from "@/lib/availability-utils";
import { cn } from "cn";
import { es } from "react-day-picker/locale";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";
import {
  billingBlocker,
  invoiceFieldsFromMessage,
  parseAmountToMinor,
  validateInvoiceFields,
  type InvoiceFieldKey,
} from "./invoice-validation";

/** "2026-11-03" → Date local sin desfase de zona horaria.
 *  Con round-trip: rechaza 2026-02-30 (new Date hace rollover a 02-mar). */
function parseISODate(v: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(y, mo - 1, d);
  if (Number.isNaN(dt.getTime())) return undefined;
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return undefined;
  return dt;
}

function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "2026-11-03" → "03/11/2026". */
function formatShort(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

/** Date picker shadcn (Popover + Calendar, mismo patrón que nueva-form):
 *  fecha válida o vacía (con X para limpiar), nunca texto libre. */
function InvoiceDatePicker({
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
  fieldKey: "issue" | "due";
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
                {selected ? formatShort(value) : "Elegir…"}
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
                  onChange(toISODate(d));
                  setOpen(false);
                }
              }}
            />
          </PopoverContent>
        </Popover>
        {selected && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Limpiar ${pickerLabel}`}
            title="Limpiar fecha"
            onClick={() => onChange("")}
            disabled={disabled}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}

/** Registra una factura emitida (dialog del drawer, tab Cobranza).
 *  Moneda = la de la orden (solo lectura): el servidor la hereda y el
 *  trigger de paridad aborta cualquier mezcla. */
export function InvoiceForm({
  orderId,
  orderCurrency,
  paymentTermsDays,
  onSaved,
  onCancel,
  billingName,
  billingTaxId,
}: {
  orderId: string;
  orderCurrency: string;
  paymentTermsDays: number | null;
  billingName: string | null;
  billingTaxId: string | null;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const issue0 = todayLima();
  const [number, setNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [issue, setIssue] = useState(issue0);
  const [due, setDue] = useState(
    typeof paymentTermsDays === "number" && paymentTermsDays >= 0 ? addDays(issue0, paymentTermsDays) : "",
  );
  const [status, setStatus] = useState("issued");
  const [pending, startTransition] = useTransition();
  const { invalid, mark, clear, bad, focusFirst } = useInvalidFields<InvoiceFieldKey>();
  const formRef = useRef<HTMLFormElement>(null);

  const missing: string[] = [];
  if (!number.trim()) missing.push("número");
  if (!amount.trim()) missing.push("monto");

  const blocked = billingBlocker({ name: billingName, taxId: billingTaxId });

  function save() {
    if (blocked) {
      toastFormError("No se puede facturar", blocked);
      return;
    }
    const problems = validateInvoiceFields({ number, amount, issue, due, status });
    if (problems.length > 0) {
      const keys = [...new Set(problems.map((p) => p.key))];
      mark(keys);
      toastFormError("Revisa los campos marcados", problems.map((p) => p.message).join(" "));
      focusFirst(formRef, keys);
      return;
    }
    const minor = parseAmountToMinor(amount);
    if (minor === null) {
      mark(["amount"]);
      toastFormError("Revisa los campos marcados", "Monto inválido: número > 0, máx 2 decimales.");
      focusFirst(formRef, ["amount"]);
      return;
    }
    startTransition(async () => {
      const res = await createInvoiceAction({
        orderId,
        number: number.trim(),
        amountMinor: minor,
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
          <span className="block text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Facturar a
          </span>
          {blocked ? (
            <span className="mt-1 block text-[13px] font-medium text-destructive">{blocked}</span>
          ) : (
            <>
              <span className="mt-0.5 block truncate text-sm font-semibold">{billingName}</span>
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="rounded-md border border-border/60 bg-background px-1.5 py-0.5 font-medium tabular-nums">
                  RUC {billingTaxId}
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
        <p id="inv-number-hint" className="text-[11px] text-muted-foreground">
          Serie y número del comprobante (ej F001-123).
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid content-start gap-1.5">
          <Label htmlFor="inv-amount">Monto ({orderCurrency}) *</Label>
          <Input
            id="inv-amount"
            name="amount"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); clear("amount"); }}
            placeholder="5,000.00"
            inputMode="decimal"
            disabled={pending}
            aria-invalid={invalid.has("amount")}
            className={bad("amount").trim() ? `text-right text-base tabular-nums${bad("amount")}` : "text-right text-base tabular-nums"}
          />
        </div>
        <div className="grid min-w-0 content-start gap-1.5">
          <span className="text-xs">Estado inicial</span>
          <Select value={status} onValueChange={(v) => { setStatus(v ?? "issued"); clear("status"); }} disabled={pending}>
            <SelectTrigger name="status" aria-label="Estado inicial" aria-invalid={invalid.has("status")} className={bad("status").trim() || undefined}>
              <SelectValue placeholder="Estado…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="issued">Emitida</SelectItem>
              <SelectItem value="paid">Pagada</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <InvoiceDatePicker
          label="Emisión"
          fieldKey="issue"
          value={issue}
          onChange={(v) => { setIssue(v); clear("issue"); clear("due"); }}
          disabled={pending}
          invalid={invalid.has("issue")}
          disabledDays={due ? (d) => toISODate(d) > due : undefined}
          pickerLabel="Fecha de emisión"
        />
        <InvoiceDatePicker
          label="Vencimiento"
          fieldKey="due"
          value={due}
          onChange={(v) => { setDue(v); clear("due"); }}
          disabled={pending}
          invalid={invalid.has("due")}
          disabledDays={issue ? (d) => toISODate(d) < issue : undefined}
          pickerLabel="Fecha de vencimiento"
        />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-4">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={pending}>
          <X aria-hidden />
          Cancelar
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={pending || blocked !== null || missing.length > 0}
          title={blocked ?? (missing.length > 0 ? `Falta: ${missing.join(" y ")}` : undefined)}
        >
          <Receipt aria-hidden />
          {pending ? "Registrando…" : "Registrar factura"}
        </Button>
      </div>
    </form>
  );
}
