import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orderStage, orderTiming, prefixForStore, buildIoNumber } from "../lib/order-stage";

const base = {
  status: "signed",
  signed: true,
  hasOm: true,
  materialsOk: true,
  started: true,
  inFlight: true,
  ended: false,
  certified: false,
};

describe("orderStage", () => {
  it("preparada futura → programada", () => {
    assert.deepEqual(orderStage({ ...base, started: false, inFlight: false }), { index: 3, stage: "programada" });
  });
  it("inicio alcanzado sin material o autorización → salida atrasada", () => {
    assert.equal(orderStage({ ...base, materialsOk: false }).stage, "atrasada");
    assert.equal(orderStage({ ...base, hasOm: false }).stage, "atrasada");
    assert.equal(orderStage({ ...base, ended: true, materialsOk: false }).stage, "atrasada");
  });
  it("borrador vencido no se presenta como emisión ni incidencia de campaña firmada", () => {
    assert.equal(orderStage({ ...base, signed: false, status: "draft", ended: true }).stage, "firmada");
  });

  it("sin firma → firmada paso 0", () => {
    assert.deepEqual(orderStage({ ...base, signed: false, hasOm: false }), { index: 0, stage: "firmada" });
  });
  it("firmada sin OM → firmada paso 1", () => {
    assert.deepEqual(orderStage({ ...base, hasOm: false, started: false, inFlight: false }), { index: 1, stage: "firmada" });
  });
  it("con OM y material pendiente → materiales", () => {
    assert.deepEqual(orderStage({ ...base, materialsOk: false, started: false, inFlight: false }), { index: 2, stage: "materiales" });
  });
  it("material ok y pauta vigente → al aire", () => {
    assert.deepEqual(orderStage(base), { index: 4, stage: "al_aire" });
  });
  it("terminada sin foto → por certificar", () => {
    assert.deepEqual(orderStage({ ...base, ended: true }), { index: 5, stage: "por_certificar" });
  });
  it("certificada → cerrada (el cobro va en carril paralelo)", () => {
    assert.deepEqual(orderStage({ ...base, ended: true, certified: true }), {
      index: 6,
      stage: "cerrada",
    });
  });
  it("paid legacy se ignora (no frena el cierre operativo)", () => {
    assert.deepEqual(orderStage({ ...base, ended: true, certified: true, paid: false }), {
      index: 6,
      stage: "cerrada",
    });
  });
  it("cancelada → -1", () => {
    assert.deepEqual(orderStage({ ...base, status: "cancelled" }), { index: -1, stage: "cancelada" });
  });
});

describe("ioNumber", () => {
  it("prefijo por iniciales", () => {
    assert.equal(prefixForStore("Strong Minds Peru SAC"), "SM");
    assert.equal(prefixForStore("Acme"), "AC");
    assert.equal(prefixForStore("A"), "OI");
    assert.equal(prefixForStore(null), "OI");
    assert.equal(prefixForStore("123"), "OI");
  });
  it("formato prefijo-año-correlativo", () => {
    assert.equal(buildIoNumber("SM", 2026, 5), "SM-2026-0005");
  });
});

describe("orderTiming", () => {
  const order = { starts_at: "2026-11-10", ends_at: "2026-11-10" };
  it("cabecera incluye todo el último día de Lima y comienza a medianoche local", () => {
    assert.equal(orderTiming(order, [], Date.parse("2026-11-10T04:59:59Z")).started, false);
    assert.equal(orderTiming(order, [], Date.parse("2026-11-10T05:00:00Z")).inFlight, true);
    assert.equal(orderTiming(order, [], Date.parse("2026-11-11T04:59:59Z")).ended, false);
    assert.equal(orderTiming(order, [], Date.parse("2026-11-11T05:00:00Z")).ended, true);
  });
  const lines = [
    { starts_at: "2026-11-10T00:00:00-05:00", ends_at: "2026-11-11T00:00:00-05:00" },
    { starts_at: "2026-11-15T00:00:00-05:00", ends_at: "2026-11-16T00:00:00-05:00" },
  ];
  it("no declara al aire el hueco entre líneas ni cierra mientras quedan períodos futuros", () => {
    const timing = orderTiming(order, lines, Date.parse("2026-11-12T12:00:00Z"));
    assert.deepEqual(timing, { started: true, inFlight: false, ended: false });
    assert.equal(orderStage({ ...base, ...timing }).stage, "programada");
  });
  it("fin exclusivo de línea no agrega otro día", () => {
    assert.equal(orderTiming(order, lines, Date.parse("2026-11-16T05:00:00Z")).ended, true);
  });
});
