// Issue #26: auto-refresh transparente. Helper puro: stale-solo-pending,
// límite N, 1-por-cliente, nunca approved/dispatched, nunca señales cerradas.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COPYWRITER_GEN,
  selectStaleRefresh,
  type StaleDraftRow,
} from "@/lib/copywriter-gen";

const OLD = "copywriter:v14:algo-viejo";

function draft(
  id: string,
  signalId: string | null,
  customerId: string,
  status = "pending_review",
  generator: string | null = OLD,
): StaleDraftRow {
  return { id, signalId, customerId, status, generator };
}

describe("stale-refresh selector", () => {
  it("solo pending_review stale con señal viva", () => {
    const drafts = [
      draft("a1", "s1", "c1"),
      draft("a2", "s2", "c2", "approved", OLD),
      draft("a3", "s3", "c3", "dispatched", OLD),
      draft("a4", "s4", "c4", "rejected", OLD),
      draft("a5", "s5", "c5", "pending_review", COPYWRITER_GEN),
      draft("a6", "s6", "c6", "pending_review", null),
    ];
    const signals = { s1: "actioned", s2: "actioned", s3: "actioned", s4: "actioned", s5: "actioned", s6: "prioritized" };
    const picked = selectStaleRefresh(drafts, signals, { limit: 10 });
    const ids = picked.map((p) => p.id).sort();
    assert.deepEqual(ids, ["a1", "a6"]);
  });

  it("nunca señales cerradas/dismissed ni huérfanos", () => {
    const drafts = [
      draft("b1", "closed1", "c1"),
      draft("b2", "dis1", "c2"),
      draft("b3", null, "c3"),
      draft("b4", "missing", "c4"),
      draft("b5", "open1", "c5"),
    ];
    const signals = { closed1: "closed", dis1: "dismissed", open1: "open" };
    const picked = selectStaleRefresh(drafts, signals, { limit: 10 });
    assert.deepEqual(picked.map((p) => p.id), ["b5"]);
  });

  it("respeta límite N y 1-por-cliente con orden determinista", () => {
    const drafts = [
      draft("c3", "s3", "c1"),
      draft("c1", "s1", "c1"),
      draft("c2", "s2", "c2"),
      draft("c4", "s4", "c3"),
    ];
    const signals = { s1: "actioned", s2: "actioned", s3: "actioned", s4: "actioned" };
    const picked = selectStaleRefresh(drafts, signals, { limit: 2 });
    // Orden por id: c1 (c1), c2 (c2); c3 mismo cliente que c1 se omite, c4 fuera de límite.
    assert.deepEqual(picked.map((p) => p.id), ["c1", "c2"]);
  });

  it("respeta busySignal/busyCustomer frescos", () => {
    const drafts = [draft("d1", "s1", "c1"), draft("d2", "s2", "c2"), draft("d3", "s3", "c3")];
    const signals = { s1: "actioned", s2: "prioritized", s3: "open" };
    const picked = selectStaleRefresh(drafts, signals, {
      limit: 10,
      busySignal: new Set(["s1"]),
      busyCustomer: new Set(["c2"]),
    });
    assert.deepEqual(picked.map((p) => p.id), ["d3"]);
  });

  it("límite acotado a 10 aunque pidan más", () => {
    const drafts = Array.from({ length: 20 }, (_, i) =>
      draft(`e${String(i).padStart(2, "0")}`, `s${i}`, `c${i}`),
    );
    const signals: Record<string, string> = {};
    for (let i = 0; i < 20; i++) signals[`s${i}`] = "actioned";
    const picked = selectStaleRefresh(drafts, signals, { limit: 50 });
    assert.equal(picked.length, 10);
  });
});
