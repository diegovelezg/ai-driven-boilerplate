// Cobranza derivada de cobros aplicados, separada del avance operativo.
import { DAY_MS, isoDayPart, limaDayStart, todayLima } from "@/lib/format";

export type BillingStatusKey = "sin_facturar" | "facturado" | "parcial" | "pagado" | "vencido";
export const BILLING_LABELS: Record<BillingStatusKey, string> = {
  sin_facturar: "Sin facturar", facturado: "Facturado", parcial: "Parcial", pagado: "Pagado", vencido: "Vencido",
};
export interface BillingPayment {
  amount_minor: number;
  paid_on: string | null;
  source: "payment" | "legacy_balance";
  voided_at: string | null;
}
export interface BillingInvoice {
  amount_minor: number | null | undefined;
  status: string | null | undefined;
  issue_date?: string | null;
  due_date?: string | null;
  payments: BillingPayment[];
}
export interface BillingInput {
  gross_minor: number;
  invoices: BillingInvoice[];
  starts_at?: string | null;
  payment_terms_days?: number | null;
  now?: number;
}
export interface BillingSummary {
  status: BillingStatusKey;
  invoiced_minor: number;
  paid_minor: number;
  pending_minor: number;
  unbilled_minor: number;
  overdue_minor: number;
  isPrepaid: boolean;
}
export interface CobranzaTotals {
  invoicedMinor: number;
  paidMinor: number;
  pendingMinor: number;
  overdueMinor: number;
}

/** El query debe incluir payments:io_invoice_payments(*). Nunca presumir
 * ausencia de cobros cuando una consulta olvidó pedir el registro. */
export function toBillingInvoice(row: Record<string, unknown>): BillingInvoice {
  if (!Array.isArray(row.payments)) throw new Error("Factura sin registro de cobros cargado.");
  return {
    amount_minor: Number(row.amount_minor ?? 0),
    status: String(row.status ?? ""),
    issue_date: row.issue_date as string | null,
    due_date: row.due_date as string | null,
    payments: row.payments as BillingPayment[],
  };
}

function paymentsAt(inv: BillingInvoice, asOfMs: number): BillingPayment[] {
  if (!Array.isArray(inv.payments)) throw new Error("Factura sin registro de cobros cargado.");
  const day = todayLima(new Date(asOfMs));
  return inv.payments.filter((p) =>
    (!p.voided_at || Date.parse(p.voided_at) > asOfMs)
    && (p.source === "legacy_balance" || (p.paid_on !== null && p.paid_on <= day)),
  );
}
export function invoicePaidMinor(inv: BillingInvoice, asOfMs: number): number {
  return paymentsAt(inv, asOfMs).reduce((sum, p) => sum + Number(p.amount_minor), 0);
}
function effectiveDueMs(inv: BillingInvoice, paymentTermsDays: number | null): number | null {
  const direct = isoDayPart(inv.due_date);
  if (direct) return Date.parse(limaDayStart(direct));
  const issue = isoDayPart(inv.issue_date);
  return issue && paymentTermsDays !== null && paymentTermsDays >= 0
    ? Date.parse(limaDayStart(issue)) + paymentTermsDays * DAY_MS : null;
}
function active(inv: BillingInvoice): boolean {
  return inv.status === "issued" || inv.status === "paid" || inv.status === "overdue";
}
function totals(invoices: BillingInvoice[], asOfMs: number, terms: number | null): CobranzaTotals {
  let invoicedMinor = 0, paidMinor = 0, overdueMinor = 0;
  const today = Date.parse(limaDayStart(todayLima(new Date(asOfMs))));
  for (const inv of invoices.filter(active)) {
    const amount = Number(inv.amount_minor ?? 0);
    const paid = invoicePaidMinor(inv, asOfMs);
    invoicedMinor += amount;
    paidMinor += paid;
    const due = effectiveDueMs(inv, terms);
    if (inv.status === "overdue" || (due !== null && due < today)) {
      overdueMinor += Math.max(0, amount - paid);
    }
  }
  return { invoicedMinor, paidMinor, pendingMinor: Math.max(0, invoicedMinor - paidMinor), overdueMinor };
}
export function aggregateCobranza(invoices: BillingInvoice[], asOfMs: number): CobranzaTotals {
  return totals(invoices, asOfMs, null);
}
export function billingStatus(input: BillingInput): BillingSummary {
  const now = input.now ?? Date.now();
  const t = totals(input.invoices, now, input.payment_terms_days ?? null);
  const unbilled = Math.max(0, input.gross_minor - t.invoicedMinor);
  const startDay = isoDayPart(input.starts_at);
  // Un saldo histórico no tiene fecha conocida: nunca demuestra un prepago.
  const prepaid = !!startDay && input.invoices.filter(active).some((inv) =>
    paymentsAt(inv, now).some((p) => p.source === "payment" && p.paid_on !== null && p.paid_on < startDay),
  );
  const status: BillingStatusKey = t.overdueMinor > 0 ? "vencido"
    : t.paidMinor > 0 && t.pendingMinor === 0 && unbilled === 0 ? "pagado"
    : t.paidMinor > 0 ? "parcial"
    : t.invoicedMinor > 0 ? "facturado" : "sin_facturar";
  return {
    status, invoiced_minor: t.invoicedMinor, paid_minor: t.paidMinor,
    pending_minor: t.pendingMinor, unbilled_minor: unbilled,
    overdue_minor: t.overdueMinor, isPrepaid: prepaid,
  };
}
