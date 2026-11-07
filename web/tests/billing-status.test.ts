import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { billingStatus } from "../lib/billing-status";

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
