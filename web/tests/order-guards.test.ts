// Guardia "nada nuevo con archivados" (lib/order-guards.ts).
// Puro y testeable (tsx --test, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { archivedBlockerMessage } from "../lib/order-guards";

describe("archivedBlockerMessage", () => {
  it("null si todas las contrapartes están activas", () => {
    assert.equal(
      archivedBlockerMessage([
        { label: "facturador", archived: false },
        { label: "firmante", archived: false, name: "Milu Palacios" },
      ]),
      null,
    );
  });
  it("bloquea una archivada con nombre y cómo desbloquear", () => {
    assert.equal(
      archivedBlockerMessage([{ label: "facturador", archived: true, name: "Tottus" }]),
      "facturador (Tottus) archivado: restáuralo para operar con esta orden.",
    );
  });
  it("bloquea varias en plural, sin nombre si falta", () => {
    assert.equal(
      archivedBlockerMessage([
        { label: "firmante", archived: true },
        { label: "pago", archived: true, name: "Lázaro" },
      ]),
      "firmante, pago (Lázaro) archivados: restáuralo para operar con esta orden.",
    );
  });
});
