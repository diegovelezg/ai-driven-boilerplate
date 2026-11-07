import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orderStage, prefixForStore, buildIoNumber } from "../lib/order-stage";

const base = {
  status: "signed",
  signed: true,
  hasOm: true,
  materialsOk: true,
  ended: false,
  certified: false,
};

describe("orderStage", () => {
  it("sin firma → firmada paso 0", () => {
    assert.deepEqual(orderStage({ ...base, signed: false, hasOm: false }), { index: 0, stage: "firmada" });
  });
  it("firmada sin OM → firmada paso 1", () => {
    assert.deepEqual(orderStage({ ...base, hasOm: false }), { index: 1, stage: "firmada" });
  });
  it("con OM y material pendiente → materiales", () => {
    assert.deepEqual(orderStage({ ...base, materialsOk: false }), { index: 2, stage: "materiales" });
  });
  it("material ok y pauta vigente → al aire", () => {
    assert.deepEqual(orderStage(base), { index: 3, stage: "al_aire" });
  });
  it("terminada sin foto → por certificar", () => {
    assert.deepEqual(orderStage({ ...base, ended: true }), { index: 4, stage: "por_certificar" });
  });
  it("certificada → cerrada (el cobro va en carril paralelo)", () => {
    assert.deepEqual(orderStage({ ...base, ended: true, certified: true }), {
      index: 5,
      stage: "cerrada",
    });
  });
  it("paid legacy se ignora (no frena el cierre operativo)", () => {
    assert.deepEqual(orderStage({ ...base, ended: true, certified: true, paid: false }), {
      index: 5,
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
