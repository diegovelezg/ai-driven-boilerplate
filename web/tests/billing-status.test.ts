import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateCobranza, billingStatus, toBillingInvoice } from "../lib/billing-status";

const DAY = 86_400_000;
const now = Date.parse("2026-11-10T00:00:00Z");

describe("billingStatus", () => {
  it("sin facturas → sin_facturar", () => {
    assert.equal(billingStatus({ gross_minor: 10000, invoices: [], now }).status, "sin_facturar");
  });
  it("draft/cancelled se ignoran", () => {
    const s = billingStatus({
      gross_minor: 10000,
      now,
      invoices: [
        { amount_minor: 10000, status: "draft", payments: [] },
        { amount_minor: 10000, status: "cancelled", payments: [] },
      ],
    });
    assert.equal(s.status, "sin_facturar");
    assert.equal(s.invoiced_minor, 0);
  });
  it("emitida no vencida → facturado (a mitad de pauta)", () => {
    const s = billingStatus({
      gross_minor: 10000,
      starts_at: "2026-11-01",
      now,
      invoices: [{ amount_minor: 10000, status: "issued", issue_date: "2026-11-05", due_date: "2026-12-05", payments: [] }],
    });
    assert.equal(s.status, "facturado");
    assert.equal(s.pending_minor, 10000);
  });
  it("upfront: pagada antes del inicio → pagado + prepago", () => {
    const s = billingStatus({
      gross_minor: 10000,
      starts_at: "2026-11-01",
      now: Date.parse("2026-10-20T00:00:00Z"),
      invoices: [{ amount_minor: 10000, status: "paid", issue_date: "2026-10-15", payments: [{ amount_minor: 10000, paid_on: "2026-10-16", source: "payment", voided_at: null }] }],
    });
    assert.equal(s.status, "pagado");
    assert.equal(s.isPrepaid, true);
  });
  it("anticipo pagado a mitad de pauta → parcial", () => {
    const s = billingStatus({
      gross_minor: 10000,
      starts_at: "2026-11-01",
      now,
      invoices: [
        { amount_minor: 5000, status: "paid", issue_date: "2026-11-02", payments: [{ amount_minor: 5000, paid_on: null, source: "legacy_balance", voided_at: null }] },
        { amount_minor: 5000, status: "issued", issue_date: "2026-11-05", due_date: "2026-12-05", payments: [] },
      ],
    });
    assert.equal(s.status, "parcial");
    assert.equal(s.paid_minor, 5000);
    assert.equal(s.pending_minor, 5000);
    assert.equal(s.isPrepaid, false);
  });
  it("total pagado aunque la pauta siga vigente → pagado", () => {
    const s = billingStatus({
      gross_minor: 10000,
      starts_at: "2026-11-01",
      now,
      invoices: [{ amount_minor: 10000, status: "paid", issue_date: "2026-11-02", payments: [{ amount_minor: 10000, paid_on: null, source: "legacy_balance", voided_at: null }] }],
    });
    assert.equal(s.status, "pagado");
  });
  it("vencida por due_date → vencido", () => {
    const s = billingStatus({
      gross_minor: 10000,
      now,
      invoices: [{ amount_minor: 10000, status: "issued", issue_date: "2026-09-01", due_date: "2026-10-01", payments: [] }],
    });
    assert.equal(s.status, "vencido");
    assert.equal(s.overdue_minor, 10000);
  });
  it("vencida por terms (sin due_date) → vencido", () => {
    const s = billingStatus({
      gross_minor: 10000,
      payment_terms_days: 30,
      now: now + 40 * DAY,
      invoices: [{ amount_minor: 10000, status: "issued", issue_date: "2026-11-01", payments: [] }],
    });
    assert.equal(s.status, "vencido");
  });
  it("overdue explícito → vencido", () => {
    const s = billingStatus({
      gross_minor: 10000,
      now,
      invoices: [{ amount_minor: 3000, status: "overdue", payments: [] }],
    });
    assert.equal(s.status, "vencido");
  });
});

describe("aggregateCobranza", () => {
  const inv = (over: Record<string, unknown> = {}) => ({
    amount_minor: 10000,
    payments: [],
    status: "issued",
    issue_date: "2026-11-05",
    due_date: "2026-12-05",
    ...over,
  });
  it("agrega emitido/pagado y calcula pendiente", () => {
    const t = aggregateCobranza(
      [inv({}), inv({ amount_minor: 5000, status: "paid", issue_date: "2026-11-02", payments: [{ amount_minor: 5000, paid_on: null, source: "legacy_balance", voided_at: null }] })],
      now,
    );
    assert.deepEqual(t, { invoicedMinor: 15000, paidMinor: 5000, pendingMinor: 10000, overdueMinor: 0 });
  });
  it("draft/cancelled se ignoran; sin due_date no se presume vencido", () => {
    const t = aggregateCobranza(
      [
        inv({ status: "draft" }),
        inv({ status: "cancelled" }),
        inv({ due_date: null, issue_date: "2026-09-01" }),
      ],
      now,
    );
    assert.deepEqual(t, { invoicedMinor: 10000, paidMinor: 0, pendingMinor: 10000, overdueMinor: 0 });
  });
  it("vencido respeta el corte asOf (cierre de mes anterior)", () => {
    const rows = [inv({ due_date: "2026-11-14" })];
    // Al 09/11 aún no vence; al cierre de noviembre sí.
    assert.equal(aggregateCobranza(rows, now).overdueMinor, 0);
    assert.equal(aggregateCobranza(rows, Date.parse("2026-12-01T00:00:00Z")).overdueMinor, 10000);
  });
  it("overdue topado al pendiente", () => {
    const t = aggregateCobranza(
      [
        { amount_minor: 8000, status: "overdue", payments: [] },
        { amount_minor: 8000, status: "paid", payments: [{ amount_minor: 8000, paid_on: null, source: "legacy_balance", voided_at: null }] },
      ],
      now,
    );
    assert.deepEqual(t, { invoicedMinor: 16000, paidMinor: 8000, pendingMinor: 8000, overdueMinor: 8000 });
  });
});

describe("cobros parciales y trazabilidad", () => {
  const payment = { amount_minor: 300000, paid_on: "2026-11-05", source: "payment" as const, voided_at: null };
  const invoice = { amount_minor: 1000000, status: "issued", issue_date: "2026-11-01", due_date: "2026-11-08", payments: [payment] };
  it("un abono de 3000 sobre factura de 10000 deja 7000, solo ese saldo vence", () => {
    const s = billingStatus({ gross_minor: 1000000, invoices: [invoice], now });
    assert.equal(s.paid_minor, 300000);
    assert.equal(s.pending_minor, 700000);
    assert.equal(s.overdue_minor, 700000);
    assert.equal(s.status, "vencido");
  });
  it("la fecha de emisión no convierte una factura impaga en prepago", () => {
    assert.equal(billingStatus({ gross_minor: 1000000, starts_at: "2026-12-01", invoices: [{ ...invoice, payments: [] }], now }).isPrepaid, false);
  });
  it("solo cobros fechados antes del inicio demuestran prepago", () => {
    assert.equal(billingStatus({ gross_minor: 1000000, starts_at: "2026-11-08", invoices: [invoice], now }).isPrepaid, true);
    assert.equal(billingStatus({ gross_minor: 1000000, starts_at: "2026-11-01", invoices: [invoice], now }).isPrepaid, false);
    const legacy = { ...invoice, status: "paid", payments: [{ ...payment, source: "legacy_balance" as const, paid_on: null }] };
    assert.equal(billingStatus({ gross_minor: 1000000, starts_at: "2026-12-01", invoices: [legacy], now }).isPrepaid, false);
  });
  it("no suma cobros que todavía no habían ocurrido en el corte histórico", () => {
    assert.equal(aggregateCobranza([invoice], Date.parse("2026-11-04T12:00:00Z")).paidMinor, 0);
    assert.equal(aggregateCobranza([invoice], now).paidMinor, 300000);
  });
  it("revertir conserva la historia pero deja de aplicar el importe", () => {
    const reversed = { ...invoice, payments: [{ ...payment, voided_at: "2026-11-09T12:00:00Z" }] };
    assert.equal(aggregateCobranza([reversed], now).paidMinor, 0);
    assert.equal(aggregateCobranza([reversed], Date.parse("2026-11-08T12:00:00Z")).paidMinor, 300000);
  });
  it("separa lo pendiente de facturar de la deuda de facturas", () => {
    const s = billingStatus({ gross_minor: 1500000, invoices: [invoice], now });
    assert.equal(s.unbilled_minor, 500000);
    assert.equal(s.pending_minor, 700000);
  });
  it("marcar paid sin cobros no fabrica dinero", () => {
    assert.equal(billingStatus({ gross_minor: 1000000, invoices: [{ ...invoice, status: "paid", payments: [] }], now }).paid_minor, 0);
  });
  it("omitir el registro en un query falla explícitamente", () => {
    assert.throws(() => toBillingInvoice({ amount_minor: 1000, status: "paid" }), /registro de cobros/);
  });
});
