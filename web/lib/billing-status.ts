// Carril administrativo (cobro) en paralelo al carril operativo (order-stage).
// Estándar OOH order-to-cash: la factura puede salir antes, durante o después
// de la pauta (upfront, 50/50, net-30/45/60). Por eso el cobro NO es una etapa
// lineal: se deriva de invoices vs bruto por montos, no por existencia.
import { DAY_MS, isoDayPart, startOfDayUTC, utcDayStart } from "@/lib/format";

export type BillingStatusKey =
  | "sin_facturar"
  | "facturado"
  | "parcial"
  | "pagado"
  | "vencido";

export const BILLING_LABELS: Record<BillingStatusKey, string> = {
  sin_facturar: "Sin facturar",
  facturado: "Facturado",
  parcial: "Parcial",
  pagado: "Pagado",
  vencido: "Vencido",
};

export interface BillingInvoice {
  amount_minor: number | null | undefined;
  status: string | null | undefined;
  issue_date?: string | null | undefined;
  due_date?: string | null | undefined;
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
  overdue_minor: number;
  isPrepaid: boolean;
}

/** Totales de cobranza de un conjunto de facturas (mes o cartera). */
export interface CobranzaTotals {
  invoicedMinor: number;
  paidMinor: number;
  pendingMinor: number;
  overdueMinor: number;
}

/** Agrega facturas con corte `asOfMs`, mismo criterio que billingStatus:
 *  draft/cancelled se ignoran; sin due_date no se presume vencido (los
 *  términos viven en la orden, no en la factura). Puro y testeable. */
export function aggregateCobranza(
  invoices: BillingInvoice[],
  asOfMs: number,
): CobranzaTotals {
  let invoiced = 0;
  let paid = 0;
  let overdueRaw = 0;
  for (const inv of invoices ?? []) {
    const amount = Math.max(0, Math.round(Number(inv.amount_minor ?? 0) || 0));
    const st = String(inv.status ?? "");
    if (st === "cancelled" || st === "draft" || amount < 0) continue;
    if (st === "paid") {
      invoiced += amount;
      paid += amount;
      continue;
    }
    if (st === "overdue") {
      invoiced += amount;
      overdueRaw += amount;
      continue;
    }
    if (st === "issued") {
      invoiced += amount;
      const day = dayPart(inv.due_date);
      const due = day ? Date.parse(utcDayStart(day)) : NaN;
      if (Number.isFinite(due) && (due as number) < asOfMs) overdueRaw += amount;
    }
    // Otros estados futuros se ignoran (no suman facturado).
  }
  const pending = Math.max(0, invoiced - paid);
  return {
    invoicedMinor: invoiced,
    paidMinor: paid,
    pendingMinor: pending,
    overdueMinor: Math.min(overdueRaw, pending),
  };
}

function dayPart(v: string | null | undefined): string | null {
  return isoDayPart(v);
}

function effectiveDueMs(
  inv: BillingInvoice,
  paymentTermsDays: number | null,
): number | null {
  const direct = dayPart(inv.due_date);
  if (direct) {
    const t = Date.parse(utcDayStart(direct));
    return Number.isFinite(t) ? t : null;
  }
  const issue = dayPart(inv.issue_date);
  if (issue && typeof paymentTermsDays === "number" && paymentTermsDays >= 0) {
    const t = Date.parse(utcDayStart(issue));
    if (!Number.isFinite(t)) return null;
    return t + paymentTermsDays * DAY_MS;
  }
  return null;
}

/** Cobro por montos. Ignora draft/cancelled: solo issued/paid/overdue facturan. */
export function billingStatus(input: BillingInput): BillingSummary {
  const gross = Number(input.gross_minor ?? 0);
  const nowMs = typeof input.now === "number" ? input.now : Date.now();
  const today00 = startOfDayUTC(nowMs);
  const terms =
    typeof input.payment_terms_days === "number" && input.payment_terms_days >= 0
      ? input.payment_terms_days
      : null;
  const startDay = dayPart(input.starts_at ?? null);

  let invoiced = 0;
  let paid = 0;
  let overdueRaw = 0;
  let prepaid = false;

  for (const inv of input.invoices ?? []) {
    const amount = Math.max(0, Math.round(Number(inv.amount_minor ?? 0) || 0));
    const st = String(inv.status ?? "");
    if (st === "cancelled" || st === "draft" || amount < 0) continue;
    // Prepaid: la factura salió antes del inicio, cuente pagada o no (upfront issued).
    const issueDay = dayPart(inv.issue_date ?? null);
    if (startDay && issueDay && issueDay < startDay) prepaid = true;
    if (st === "paid") {
      invoiced += amount;
      paid += amount;
      continue;
    }
    if (st === "overdue") {
      invoiced += amount;
      overdueRaw += amount;
      continue;
    }
    if (st === "issued") {
      invoiced += amount;
      const due = effectiveDueMs(inv, terms);
      if (due !== null && due < today00) overdueRaw += amount;
    }
    // Otros estados futuros se ignoran (no suman facturado).
  }

  const pending = Math.max(0, invoiced - paid);
  const overdue = Math.min(overdueRaw, pending);
  const target = gross > 0 ? gross : invoiced;

  let status: BillingStatusKey;
  if (paid > 0 && target > 0 && paid >= target) {
    status = "pagado";
  } else if (overdue > 0 && pending > 0) {
    status = "vencido";
  } else if (paid > 0) {
    status = "parcial";
  } else if (invoiced > 0) {
    status = "facturado";
  } else {
    status = "sin_facturar";
  }

  return {
    status,
    invoiced_minor: invoiced,
    paid_minor: paid,
    pending_minor: pending,
    overdue_minor: overdue,
    isPrepaid: prepaid,
  };
}
