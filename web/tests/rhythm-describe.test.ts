// Descripción humana del ritmo (issue #27 Paso 5.1): sustento para Review.
// Corre con: npx tsx --test tests/rhythm-describe.test.ts
import { describe, it } from "node:test";
import assert from "assert/strict";
import { describeCustomerRhythm } from "@/lib/rhythm-describe";

describe("describeCustomerRhythm (issue #27 Paso 5.1)", () => {
  it("grupo dominante ⇒ frase con su mediana, sin jerga ni probabilidades", () => {
    const s = describeCustomerRhythm({
      mixture_k: 2,
      mixture_meds: [7, 60],
      mixture_resp: [0.8, 0.2],
    });
    assert.equal(s, "Su grupo de compra suele volver a los ~7 días.");
    assert.ok(!s!.includes("μ") && !s!.includes("cluster") && !s!.includes("0.8"));
  });

  it("reparto dividido ⇒ indecisión entre dos grupos", () => {
    assert.equal(
      describeCustomerRhythm({ mixture_k: 2, mixture_meds: [7, 60], mixture_resp: [0.5, 0.5] }),
      "Su ritmo está entre dos formas de comprar (grupos de ~7 y ~60 días).",
    );
    // Frontera 0.6: dominante.
    assert.equal(
      describeCustomerRhythm({ mixture_k: 2, mixture_meds: [7, 60], mixture_resp: [0.6, 0.4] }),
      "Su grupo de compra suele volver a los ~7 días.",
    );
    // Ordena medianas aunque el dominante sea el segundo.
    assert.equal(
      describeCustomerRhythm({ mixture_k: 2, mixture_meds: [60, 7], mixture_resp: [0.3, 0.7] }),
      "Su grupo de compra suele volver a los ~7 días.",
    );
  });

  it("legacy/K=1/sin mezcla ⇒ null (la superficie no cambia)", () => {
    assert.equal(describeCustomerRhythm({ mixture_k: null, mixture_meds: null, mixture_resp: null }), null);
    assert.equal(describeCustomerRhythm({ mixture_k: 1, mixture_meds: [30], mixture_resp: [1] }), null);
    assert.equal(describeCustomerRhythm({ mixture_k: 0, mixture_meds: [], mixture_resp: [] }), null);
  });

  it("evidencia inválida ⇒ null (fail-open)", () => {
    assert.equal(describeCustomerRhythm({ mixture_k: 2, mixture_meds: null, mixture_resp: [0.8, 0.2] }), null);
    assert.equal(describeCustomerRhythm({ mixture_k: 2, mixture_meds: [7], mixture_resp: [0.8, 0.2] }), null);
    assert.equal(describeCustomerRhythm({ mixture_k: 2, mixture_meds: [7, 60], mixture_resp: [0.8, 0.5] }), null);
    assert.equal(describeCustomerRhythm({ mixture_k: 2, mixture_meds: [7, 1e12], mixture_resp: [0.8, 0.2] }), null);
    assert.equal(describeCustomerRhythm({ mixture_k: 5, mixture_meds: [1, 2, 3, 4, 5], mixture_resp: [0.2, 0.2, 0.2, 0.2, 0.2] }), null);
  });
});
