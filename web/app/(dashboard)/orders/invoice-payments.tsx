"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { SubmitButton, CancelButton } from "@/components/buttons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DrawerDialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useInvalidFields, toastFormError } from "@/components/ui/form-feedback";
import { toast } from "@/components/ui/toast";
import { recordInvoicePaymentAction, voidInvoicePaymentAction } from "@/lib/order-flow-actions";
import { invoicePaidMinor, toBillingInvoice } from "@/lib/billing-status";
import { Money } from "@/components/money";
import { formatDate, formatDateTime, isValidISODate, todayLima, toISODateLocal } from "@/lib/format";
import { InvoiceDatePicker } from "./invoice-form";
import { parseAmountToMinor } from "./invoice-validation";

type Field = "amount" | "date" | "reference" | "reason";

export function InvoicePayments({ invoice, currency, canEdit, onSaved }: {
  invoice: Record<string, unknown>;
  currency: string;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayLima);
  const [reference, setReference] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  const { invalid, mark, clear, bad, focusFirst } = useInvalidFields<Field>();
  const [now] = useState(() => Date.now());
  const inv = toBillingInvoice(invoice);
  const paid = invoicePaidMinor(inv, now);
  const balance = Math.max(0, Number(invoice.amount_minor) - paid);
  const editable = canEdit && ["issued", "paid", "overdue"].includes(String(invoice.status));
  const payments = invoice.payments as Array<Record<string, unknown>>;
  const missing = !amount.trim() ? "monto" : !date ? "fecha" : !reference.trim() ? "referencia" : null;
  function changed() { setRequestId(crypto.randomUUID()); }
  function fail(keys: Field[], message: string) {
    mark(keys);
    toastFormError("Revisa el cobro", message);
    focusFirst(ref, keys);
  }
  function save() {
    const minor = parseAmountToMinor(amount);
    if (minor === null || minor > balance) return fail(["amount"], "Indica un monto válido que no supere el saldo.");
    if (!isValidISODate(date) || date > todayLima()) return fail(["date"], "Indica una fecha de cobro válida, hasta hoy.");
    if (!reference.trim() || reference.trim().length > 200) return fail(["reference"], "Indica una referencia (máx 200).");
    startTransition(async () => {
      const result = await recordInvoicePaymentAction({ invoiceId: String(invoice.id), requestId, amountMinor: minor, paidOn: date, reference });
      if (!result.ok) {
        const keys: Field[] = /monto|saldo/i.test(result.message) ? ["amount"]
          : /fecha/i.test(result.message) ? ["date"] : /referencia/i.test(result.message) ? ["reference"] : [];
        if (keys.length) { mark(keys); focusFirst(ref, keys); }
        toastFormError("No se pudo registrar el cobro", result.message); return;
      }
      toast.add({ title: "Cobro registrado", description: result.message, type: "success" });
      setAmount(""); setReference(""); changed();
      onSaved();
    });
  }
  function reverse() {
    if (!reversing) return;
    if (!reason.trim() || reason.trim().length > 500) return fail(["reason"], "Indica el motivo de la reversión (máx 500).");
    startTransition(async () => {
      const result = await voidInvoicePaymentAction({ invoiceId: String(invoice.id), paymentId: reversing, reason });
      if (!result.ok) { toastFormError("No se pudo revertir el registro", result.message); return; }
      toast.add({ title: "Registro revertido", description: result.message, type: "success" });
      setReversing(null); setReason(""); onSaved();
    });
  }
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!pending) { setOpen(v); setReversing(null); } }}>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)} aria-label={`Ver cobros de factura ${invoice.number}`}>
        Cobros
      </Button>
      <DrawerDialogContent className="max-h-[85vh] overflow-y-auto p-6 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Cobros · {String(invoice.number)}</DialogTitle>
          <DialogDescription>Registra abonos aplicados a esta factura. Revertir corrige el registro; no ejecuta una devolución bancaria.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-3 gap-4 text-sm tabular-nums">
          <div><dt className="text-muted-foreground">Facturado</dt><dd><Money amountMinor={inv.amount_minor} currency={currency} decimals={2} /></dd></div>
          <div><dt className="text-muted-foreground">Cobrado</dt><dd><Money amountMinor={paid} currency={currency} decimals={2} /></dd></div>
          <div><dt className="text-muted-foreground">Saldo</dt><dd><Money amountMinor={balance} currency={currency} decimals={2} /></dd></div>
        </dl>
        <ul className="flex flex-col gap-3" aria-label="Historial de cobros">
          {payments.length === 0 && <li className="text-sm text-muted-foreground">Todavía no hay cobros registrados.</li>}
          {payments.map((p) => (
            <li key={String(p.id)} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="font-medium tabular-nums"><Money amountMinor={Number(p.amount_minor)} currency={currency} decimals={2} />{p.voided_at ? " · Revertido" : ""}</span>
                {editable && !p.voided_at && <Button size="xs" variant="ghost" disabled={pending} onClick={() => { setReversing(String(p.id)); setReason(""); }}>Revertir registro</Button>}
              </div>
              <p className="text-muted-foreground">{p.source === "legacy_balance" ? "Saldo histórico declarado · fecha de cobro desconocida" : `${formatDate(p.paid_on)} · ${String(p.reference)}`}</p>
              {p.created_by != null && <p className="text-xs text-muted-foreground">Registrado por {String(p.created_by)} · {formatDateTime(p.created_at)}</p>}
              {p.voided_at != null && <p className="text-xs text-muted-foreground">Reversión: {String(p.void_reason)} · {formatDateTime(p.voided_at)}{p.voided_by ? ` · ${String(p.voided_by)}` : ""}</p>}
            </li>
          ))}
        </ul>
        {editable && (reversing ? (
          <form ref={ref} noValidate className="flex flex-col gap-4 border-t pt-4" onSubmit={(e) => { e.preventDefault(); reverse(); }}>
            <div className="form-field">
              <Label htmlFor="payment-reason">Motivo de la reversión *</Label>
              <Input id="payment-reason" name="reason" value={reason} onChange={(e) => { setReason(e.target.value); clear("reason"); }} maxLength={500} disabled={pending} aria-invalid={invalid.has("reason")} className={bad("reason")} />
            </div>
            <div className="flex justify-end gap-2"><CancelButton size="sm" disabled={pending} onCancel={() => setReversing(null)} /><SubmitButton size="sm" pending={pending} disabled={!reason.trim()} title={!reason.trim() ? "Falta el motivo" : undefined}>Revertir registro</SubmitButton></div>
          </form>
        ) : balance > 0 && (
          <form ref={ref} noValidate className="flex flex-col gap-4 border-t pt-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <div className="form-field">
              <Label htmlFor="payment-amount">Monto del abono ({currency}) *</Label>
              <Input id="payment-amount" name="amount" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); clear("amount"); changed(); }} disabled={pending} placeholder="3,000.00" aria-invalid={invalid.has("amount")} className={bad("amount")} />
            </div>
            <InvoiceDatePicker label="Fecha de cobro *" fieldKey="date" value={date} onChange={(v) => { setDate(v); clear("date"); changed(); }} disabled={pending} invalid={invalid.has("date")} disabledDays={(d) => toISODateLocal(d) > todayLima()} pickerLabel="Fecha de cobro" />
            <div className="form-field">
              <Label htmlFor="payment-reference">Referencia *</Label>
              <Input id="payment-reference" name="reference" value={reference} onChange={(e) => { setReference(e.target.value); clear("reference"); changed(); }} maxLength={200} disabled={pending} placeholder="Operación bancaria o recibo" aria-invalid={invalid.has("reference")} className={bad("reference")} />
            </div>
            <div className="flex justify-end"><SubmitButton size="sm" pending={pending} disabled={missing !== null} title={missing ? `Falta: ${missing}` : undefined}>Registrar cobro</SubmitButton></div>
          </form>
        ))}
      </DrawerDialogContent>
    </Dialog>
  );
}
