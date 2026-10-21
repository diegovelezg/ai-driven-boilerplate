import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashOrderRows } from "@/lib/sync-runner";

const O1 = {
  external_order_id: "a1",
  customer_id: "c1",
  total_amount: 10000,
  currency: "PEN",
  status: "paid",
  payment_status: "paid",
  is_test: false,
  placed_at: "2026-10-20T10:00:00Z",
  country: "PE",
  market_id: null,
};
const O2 = { ...O1, external_order_id: "a2", total_amount: 20000 };

describe("huella de órdenes (invalida la foto del día)", () => {
  it("estable ante orden de llegada", () => {
    assert.equal(hashOrderRows([O1, O2]), hashOrderRows([O2, O1]));
  });

  it("cambia con orden nueva", () => {
    assert.notEqual(hashOrderRows([O1]), hashOrderRows([O1, O2]));
  });

  it("cambia con corrección de estado o monto", () => {
    assert.notEqual(hashOrderRows([O1]), hashOrderRows([{ ...O1, status: "refunded" }]));
    assert.notEqual(hashOrderRows([O1]), hashOrderRows([{ ...O1, total_amount: 9999 }]));
  });

  it("ignora columnas fuera del modelo", () => {
    assert.equal(
      hashOrderRows([{ ...O1, channel_id: "x", items_json: [1] }]),
      hashOrderRows([{ ...O1, channel_id: "y", items_json: [2] }]),
    );
  });

  it("set vacío estable", () => {
    assert.equal(hashOrderRows([]), hashOrderRows([]));
    assert.notEqual(hashOrderRows([]), hashOrderRows([O1]));
  });
});
