// Finanzas: KPIs por mes calendario (alineados con Hoy).
// Mes en curso a la fecha vs mismo tramo del mes anterior.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bucketMonthly, computeFinanceKpis } from "../lib/finance";

const now = Date.parse("2026-11-09T12:00:00-05:00");

const o = (placed_at: string | null, total_amount = 10000, currency: string | null = "PEN") => ({
  placed_at,
  total_amount,
  currency,
});

describe("computeFinanceKpis por mes", () => {
  it("mes en curso a la fecha vs mismo tramo del anterior", () => {
    const k = computeFinanceKpis(
      [
        o("2026-11-02T10:00:00-05:00", 20000), // mes actual
        o("2026-10-02T10:00:00-05:00", 10000), // mismo tramo mes anterior
        o("2026-10-20T10:00:00-05:00", 50000), // fuera del tramo previo
      ],
      "PEN",
      now,
    );
    assert.equal(k.salesMesMinor, 20000);
    assert.equal(k.ordersMes, 1);
    assert.equal(k.ticketMesMinor, 20000);
    assert.equal(k.salesDeltaPct, 100);
    assert.equal(k.ordersDeltaPct, 0);
  });
  it("sin base previa → null; sin órdenes → 0", () => {
    const k = computeFinanceKpis([o("2026-11-02T10:00:00-05:00", 20000)], "PEN", now);
    assert.equal(k.salesDeltaPct, null);
    const empty = computeFinanceKpis([], "PEN", now);
    assert.equal(empty.salesMesMinor, 0);
    assert.equal(empty.ticketMesMinor, 0);
    assert.equal(empty.salesDeltaPct, 0);
  });
  it("respeta moneda de la vista y excluye futuro", () => {
    const k = computeFinanceKpis(
      [
        o("2026-11-02T10:00:00-05:00", 10000, "USD"),
        o("2026-11-20T10:00:00-05:00", 99999), // futuro: se ignora
      ],
      "PEN",
      now,
    );
    assert.equal(k.salesMesMinor, 0);
    assert.equal(k.ordersMes, 0);
  });
});

describe("bucketMonthly", () => {
  it("agrupa por mes calendario incluyendo el actual", () => {
    const b = bucketMonthly(
      [o("2026-11-02T10:00:00-05:00", 20000), o("2026-10-15T10:00:00-05:00", 10000)],
      "PEN",
      now,
    );
    assert.equal(b.length, 12);
    const nov = b.find((x) => x.key === "2026-11");
    const oct = b.find((x) => x.key === "2026-10");
    assert.equal(nov?.salesMinor, 20000);
    assert.equal(nov?.orders, 1);
    assert.equal(oct?.salesMinor, 10000);
  });
});
