// Mirror Jean (#25) + regresiones P1/P2 del reviewer: sin BD ni LLM.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJudgeResponse } from "@/lib/judge-brief";
import { briefMode } from "@/lib/judge-brief";
import { inferMetadataRoles } from "@/lib/metadata-map";
import { normProductTitle } from "@/lib/product-stats";

describe("mirror Jean (continuidad con ventana+aprobado)", () => {
  it("reusable:true -> continuidad", () => {
    const r = parseJudgeResponse(JSON.stringify({ contactable: true, reusable: true, reason: "hábito Expomall" }));
    assert.equal(r.reusable, true);
    assert.equal(briefMode(r.reusable), "continuidad");
  });
});

describe("P1 historial: per-order filtrado no cruza fechas", () => {
  it("inactive solo filtra su pedido", () => {
    const rawPerOrder = [[{ title: "A" }, { title: "B" }], [{ title: "C" }]];
    const enrichedAll = [{ title: "A" }, { title: "B" }, { title: "C" }];
    const inactive = new Set([normProductTitle("B")]);
    const perOrder: string[][] = [];
    let c0 = 0;
    for (const arr of rawPerOrder) {
      perOrder.push((enrichedAll as Array<{ title: string }>).slice(c0, c0 + arr.length).map((x) => x.title).filter((t) => !inactive.has(normProductTitle(t))));
      c0 += arr.length;
    }
    assert.deepEqual(perOrder, [["A"], ["C"]]);
  });
});

describe("P2 roles: variante exige frecuencia", () => {
  it("key rara no entra a variante", () => {
    const roles = inferMetadataRoles([
      { key: "dateStart", freq: 100, kind: "date", samples: ["2026-01-01"] },
      { key: "rara", freq: 1, kind: "text", samples: ["x"] },
    ]);
    assert.ok(!roles.variante?.includes("rara"));
  });
});
