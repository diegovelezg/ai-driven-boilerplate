import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateCobranza, billingStatus } from "../lib/billing-status";

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
        { amount_minor: 10000, status: "draft" },
        { amount_minor: 10000, status: "cancelled" },
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
      invoices: [{ amount_minor: 10000, status: "issued", issue_date: "2026-11-05", due_date: "2026-12-05" }],
    });
    assert.equal(s.status, "facturado");
    assert.equal(s.pending_minor, 10000);
  });
  it("upfront: pagada antes del inicio → pagado + prepago", () => {
    const s = billingStatus({
      gross_minor: 10000,
      starts_at: "2026-11-01",
      now: Date.parse("2026-10-20T00:00:00Z"),
      invoices: [{ amount_minor: 10000, status: "paid", issue_date: "2026-10-15" }],
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
        { amount_minor: 5000, status: "paid", issue_date: "2026-11-02" },
        { amount_minor: 5000, status: "issued", issue_date: "2026-11-05", due_date: "2026-12-05" },
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
      invoices: [{ amount_minor: 10000, status: "paid", issue_date: "2026-11-02" }],
    });
    assert.equal(s.status, "pagado");
  });
  it("vencida por due_date → vencido", () => {
    const s = billingStatus({
      gross_minor: 10000,
      now,
      invoices: [{ amount_minor: 10000, status: "issued", issue_date: "2026-09-01", due_date: "2026-10-01" }],
    });
    assert.equal(s.status, "vencido");
    assert.equal(s.overdue_minor, 10000);
  });
  it("vencida por terms (sin due_date) → vencido", () => {
    const s = billingStatus({
      gross_minor: 10000,
      payment_terms_days: 30,
      now: now + 40 * DAY,
      invoices: [{ amount_minor: 10000, status: "issued", issue_date: "2026-11-01" }],
    });
    assert.equal(s.status, "vencido");
  });
  it("overdue explícito → vencido", () => {
    const s = billingStatus({
      gross_minor: 10000,
      now,
      invoices: [{ amount_minor: 3000, status: "overdue" }],
    });
    assert.equal(s.status, "vencido");
  });
});

describe("aggregateCobranza", () => {
  const inv = (over: Record<string, unknown> = {}) => ({
    amount_minor: 10000,
    status: "issued",
    issue_date: "2026-11-05",
    due_date: "2026-12-05",
    ...over,
  });
  it("agrega emitido/pagado y calcula pendiente", () => {
    const t = aggregateCobranza(
      [inv({}), inv({ amount_minor: 5000, status: "paid", issue_date: "2026-11-02" })],
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
        { amount_minor: 8000, status: "overdue" },
        { amount_minor: 8000, status: "paid" },
      ],
      now,
    );
    assert.deepEqual(t, { invoicedMinor: 16000, paidMinor: 8000, pendingMinor: 8000, overdueMinor: 8000 });
  });
});
