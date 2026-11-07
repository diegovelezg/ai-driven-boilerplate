// Carril administrativo (cobro) en paralelo al carril operativo (order-stage).
// Estándar OOH order-to-cash: la factura puede salir antes, durante o después
// de la pauta (upfront, 50/50, net-30/45/60). Por eso el cobro NO es una etapa
// lineal: se deriva de invoices vs bruto por montos, no por existencia.

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

function dayPart(v: string | null | undefined): string | null {
  if (typeof v !== "string" || !v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function startOfDayUTC(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function effectiveDueMs(
  inv: BillingInvoice,
  paymentTermsDays: number | null,
): number | null {
  const direct = dayPart(inv.due_date);
  if (direct) {
    const t = Date.parse(`${direct}T00:00:00Z`);
    return Number.isFinite(t) ? t : null;
  }
  const issue = dayPart(inv.issue_date);
  if (issue && typeof paymentTermsDays === "number" && paymentTermsDays >= 0) {
    const t = Date.parse(`${issue}T00:00:00Z`);
    if (!Number.isFinite(t)) return null;
    return t + paymentTermsDays * 86_400_000;
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
    if (st === "paid") {
      invoiced += amount;
      paid += amount;
      const issueDay = dayPart(inv.issue_date ?? null);
      if (startDay && issueDay && issueDay < startDay) prepaid = true;
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
