// Autocalibración de bandas (puro, sin BD): fitBandLow/fitBandHigh.
// Corre con: npm test (node:test stdlib vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BAND_FIT_MIN_PER_CLASS,
  BAND_FIT_MIN_SAMPLES,
  BAND_HIGH_MAX,
  BAND_HIGH_MIN,
  BAND_LOW_MAX,
  BAND_LOW_MIN,
  fitBandHigh,
  fitBandLow,
  type BandSample,
} from "@/lib/band-calibrate";

function separable(nNeg = 60, nPos = 60): BandSample[] {
  const out: BandSample[] = [];
  for (let i = 0; i < nNeg; i += 1) out.push({ p: 0.02 + (i % 10) * 0.005, returned: false });
  for (let i = 0; i < nPos; i += 1) out.push({ p: 0.3 + (i % 10) * 0.01, returned: true });
  return out;
}

describe("fitBandLow", () => {
  it("poca historia → null (no se toca lo vigente)", () => {
    assert.equal(fitBandLow([{ p: 0.5, returned: true }]), null);
    assert.equal(
      fitBandLow(Array.from({ length: BAND_FIT_MIN_SAMPLES - 1 }, (_, i) => ({ p: (i % 50) / 100, returned: i % 2 === 0 }))),
      null,
    );
  });

  it("sin una clase → null", () => {
    const allNeg = Array.from({ length: BAND_FIT_MIN_SAMPLES }, (_, i) => ({ p: (i % 50) / 100, returned: false }));
    assert.equal(fitBandLow(allNeg), null);
  });

  it("separable → corte entre clases dentro de guardarraíles", () => {
    const cut = fitBandLow(separable());
    assert.ok(cut !== null && cut >= BAND_LOW_MIN && cut <= BAND_LOW_MAX, `cut=${cut}`);
  });

  it("respeta mínimo de positivos por clase", () => {
    const rows: BandSample[] = [];
    for (let i = 0; i < BAND_FIT_MIN_SAMPLES; i += 1) rows.push({ p: (i % 50) / 100, returned: false });
    for (let i = 0; i < BAND_FIT_MIN_PER_CLASS - 1; i += 1) rows.push({ p: 0.9, returned: true });
    assert.equal(fitBandLow(rows), null);
  });
});

describe("fitBandHigh", () => {
  it("poca historia o sin positivos → null", () => {
    assert.equal(fitBandHigh([]), null);
    assert.equal(
      fitBandHigh(Array.from({ length: BAND_FIT_MIN_SAMPLES }, () => ({ p: 0.1, returned: false }))),
      null,
    );
  });

  it("grupo preciso arriba → high dentro de [0.3,0.8]", () => {
    const cut = fitBandHigh(separable());
    assert.ok(cut !== null && cut >= BAND_HIGH_MIN && cut <= BAND_HIGH_MAX, `cut=${cut}`);
  });

  it("maxP bajo (nada preciso arriba) → null, se conserva default", () => {
    const rows: BandSample[] = [];
    for (let i = 0; i < 80; i += 1) rows.push({ p: 0.01 + (i % 10) * 0.005, returned: false });
    for (let i = 0; i < 30; i += 1) rows.push({ p: 0.05 + (i % 10) * 0.005, returned: i % 6 === 0 });
    assert.equal(fitBandHigh(rows), null);
  });
});
