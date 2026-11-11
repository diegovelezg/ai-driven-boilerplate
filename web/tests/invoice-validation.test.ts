import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  billingBlocker,
  invoiceFieldsFromMessage,
  parseAmountToMinor,
  validateInvoiceFields,
} from "../app/(dashboard)/orders/invoice-validation";

describe("parseAmountToMinor", () => {
  it("entero → céntimos", () => {
    assert.equal(parseAmountToMinor("5000"), 500000);
  });
  it("decimales con coma de miles", () => {
    assert.equal(parseAmountToMinor("5,000.50"), 500050);
  });
  it("rechaza cero, negativo y 3 decimales", () => {
    assert.equal(parseAmountToMinor("0"), null);
    assert.equal(parseAmountToMinor("-10"), null);
    assert.equal(parseAmountToMinor("10.999"), null);
    assert.equal(parseAmountToMinor("abc"), null);
  });
  it("rechaza grupos de miles mal formados", () => {
    assert.equal(parseAmountToMinor("5,00,0"), null);
    assert.equal(parseAmountToMinor("5.000,50"), null);
    assert.equal(parseAmountToMinor(",5000"), null);
  });
});

describe("billingBlocker", () => {
  it("lista con nombre + RUC", () => {
    assert.equal(billingBlocker({ name: "Tottus", taxId: "20508565934", country: "PE" }), null);
  });
  it("sin empresa bloquea", () => {
    assert.match(billingBlocker({ name: null, taxId: null }) ?? "", /empresa de facturación/);
  });
  it("sin RUC bloquea (etiqueta según país)", () => {
    assert.match(billingBlocker({ name: "Tottus", taxId: " ", country: "PE" }) ?? "", /RUC/);
  });
  it("etiqueta el TIN del país (MX → RFC, sin país → genérico)", () => {
    assert.match(billingBlocker({ name: "Acme", taxId: null, country: "MX" }) ?? "", /RFC/);
    assert.match(billingBlocker({ name: "Acme", taxId: null }) ?? "", /ID fiscal/);
  });
});

describe("validateInvoiceFields", () => {
  it("válido mínimo (número + monto)", () => {
    const out = validateInvoiceFields({ number: "F001-123", amount: "5000", issue: "", due: "", status: "issued" });
    assert.deepStrictEqual(out, []);
  });
  it("exige número y monto", () => {
    const keys = validateInvoiceFields({ number: "", amount: "", issue: "", due: "", status: "issued" }).map((p) => p.key);
    assert.ok(keys.includes("number"));
    assert.ok(keys.includes("amount"));
  });
  it("vence antes de emisión → due", () => {
    const keys = validateInvoiceFields({
      number: "F001-1",
      amount: "100",
      issue: "2026-11-10",
      due: "2026-11-01",
      status: "issued",
    }).map((p) => p.key);
    assert.deepStrictEqual(keys, ["due"]);
  });
  it("due === issue es válido", () => {
    const out = validateInvoiceFields({
      number: "F001-1",
      amount: "100",
      issue: "2026-11-10",
      due: "2026-11-10",
      status: "issued",
    });
    assert.deepStrictEqual(out, []);
  });
  it("estado inicial solo emitida o pagada", () => {
    const keys = validateInvoiceFields({ number: "F001-1", amount: "100", issue: "", due: "", status: "draft" }).map((p) => p.key);
    assert.deepStrictEqual(keys, ["status"]);
  });
  it("rechaza fechas inexistentes (rollover UTC)", () => {
    for (const bad of ["2026-02-30", "2026-02-31", "2026-13-01", "2026-00-10", "2026-04-31"]) {
      const keys = validateInvoiceFields({ number: "F001-1", amount: "100", issue: bad, due: "", status: "issued" }).map(
        (p) => p.key,
      );
      assert.ok(keys.includes("issue"), `${bad} debe ser inválido`);
    }
  });
  it("acepta bisiesto real", () => {
    const out = validateInvoiceFields({
      number: "F001-1",
      amount: "100",
      issue: "2024-02-29",
      due: "",
      status: "issued",
    });
    assert.deepStrictEqual(out, []);
  });
});

describe("invoiceFieldsFromMessage", () => {
  it("mapea mensajes del server al campo", () => {
    assert.deepStrictEqual(invoiceFieldsFromMessage("Ese número ya existe en esta tienda."), ["number"]);
    assert.deepStrictEqual(invoiceFieldsFromMessage("Monto inválido: debe ser mayor a 0."), ["amount"]);
    assert.deepStrictEqual(invoiceFieldsFromMessage("Emisión inválida (aaaa-mm-dd)."), ["issue"]);
    assert.deepStrictEqual(invoiceFieldsFromMessage("Vence antes de la emisión."), ["due"]);
    assert.deepStrictEqual(invoiceFieldsFromMessage("Estado inicial inválido (emitida o pagada)."), ["status"]);
  });
  it("cancelada no resalta campo", () => {
    assert.deepStrictEqual(invoiceFieldsFromMessage("La orden está cancelada."), []);
  });
});
