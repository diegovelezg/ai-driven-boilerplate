// Utilidades puras de disponibilidad: huecos y días libres.
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  firstFreeDay,
  nextFreeWindow,
  todayLima,
  unionRanges,
} from "../lib/availability-utils";

describe("addDays", () => {
  it("cruza mes y año", () => {
    assert.equal(addDays("2026-11-30", 1), "2026-12-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-11-03", 21), "2026-11-24");
  });
});

describe("firstFreeDay", () => {
  it("desde el inicio si está libre", () => {
    assert.equal(firstFreeDay([{ starts: "2026-12-01", ends: "2026-12-10" }], "2026-11-03"), "2026-11-03");
  });
  it("salta la ocupación", () => {
    assert.equal(
      firstFreeDay([{ starts: "2026-11-01", ends: "2026-11-24" }], "2026-11-03"),
      "2026-11-25",
    );
  });
  it("sin rangos devuelve from", () => {
    assert.equal(firstFreeDay([], "2026-11-03"), "2026-11-03");
  });
});

describe("nextFreeWindow", () => {
  it("ventana inmediata si cabe", () => {
    assert.equal(nextFreeWindow([], "2026-11-03", 22), "2026-11-03");
  });
  it("salta al primer hueco que cabe completo", () => {
    const occ = [{ starts: "2026-11-01", ends: "2026-11-24" }];
    assert.equal(nextFreeWindow(occ, "2026-11-03", 22), "2026-11-25");
  });
  it("un hueco corto no alcanza para duración larga", () => {
    const occ = [
      { starts: "2026-11-01", ends: "2026-11-10" },
      { starts: "2026-11-15", ends: "2026-12-31" },
    ];
    // 11→14 son 4 días: no caben 22; el hueco real empieza 2027-01-01.
    assert.equal(nextFreeWindow(occ, "2026-11-03", 22), "2027-01-01");
  });
  it("adyacente al fin de ocupación sirve (fin inclusivo + 1)", () => {
    const occ = [{ starts: "2026-11-01", ends: "2026-11-24" }];
    assert.equal(nextFreeWindow(occ, "2026-11-03", 1), "2026-11-25");
  });
  it("duración inválida → null", () => {
    assert.equal(nextFreeWindow([], "2026-11-03", 0), null);
  });
});

describe("unionRanges + todayLima", () => {
  it("une listas", () => {
    assert.deepEqual(
      unionRanges([[{ starts: "a", ends: "b" }], [{ starts: "c", ends: "d" }]]),
      [{ starts: "a", ends: "b" }, { starts: "c", ends: "d" }],
    );
  });
  it("todayLima es yyyy-mm-dd", () => {
    assert.match(todayLima(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
