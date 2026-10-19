// Autocalibración del corte de seguimiento cercano: J de Youden sobre
// historia etiquetada, sin hardcodear por tienda.
// Corre con: npm test (node:test stdlib vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fitCloseWatchP,
  CLOSE_WATCH_DEFAULT_P,
  CLOSE_WATCH_FIT_MIN_SAMPLES,
  type CloseWatchSample,
} from "@/lib/customer-predictions";

function synth(nPos: number, nNeg: number, pPos: number, pNeg: number): CloseWatchSample[] {
  const out: CloseWatchSample[] = [];
  for (let i = 0; i < nPos; i += 1) out.push({ p: pPos, returned: true });
  for (let i = 0; i < nNeg; i += 1) out.push({ p: pNeg, returned: false });
  return out;
}

describe("fitCloseWatchP: corte aprendido, no hardcodeado", () => {
  it("separa distribuciones disjuntas en el borde de los positivos", () => {
    const fit = fitCloseWatchP(synth(20, 40, 0.3, 0.05));
    assert.equal(fit, 0.3);
  });

  it("sin historia suficiente conserva el default (null)", () => {
    assert.equal(fitCloseWatchP(synth(2, 3, 0.3, 0.05)), null);
    assert.equal(fitCloseWatchP(synth(30, 0, 0.3, 0.05)), null);
    assert.equal(fitCloseWatchP([]), null);
  });

  it("si p no discrimina no propone corte (null)", () => {
    const s: CloseWatchSample[] = [];
    for (let i = 0; i < 20; i += 1) s.push({ p: 0.1, returned: true });
    for (let i = 0; i < 40; i += 1) s.push({ p: 0.1, returned: false });
    assert.equal(fitCloseWatchP(s), null);
  });

  it("empate de J prefiere el corte menor (cobertura)", () => {
    // J(0.3) = 1 + 0.5 − 1 = 0.5 y J(0.5) = 0.5 + 1 − 1 = 0.5: empate real.
    const s: CloseWatchSample[] = [];
    for (let i = 0; i < 10; i += 1) s.push({ p: 0.3, returned: true });
    for (let i = 0; i < 10; i += 1) s.push({ p: 0.5, returned: true });
    for (let i = 0; i < 20; i += 1) s.push({ p: 0.1, returned: false });
    for (let i = 0; i < 20; i += 1) s.push({ p: 0.3, returned: false });
    assert.equal(fitCloseWatchP(s), 0.3);
  });

  it("clampea anti-degenerado y filtra p inválidos", () => {
    assert.equal(fitCloseWatchP(synth(20, 40, 0.9, 0.05)), 0.5);
    const weird: CloseWatchSample[] = [
      ...synth(20, 40, 0.3, 0.05),
      { p: NaN, returned: true },
      { p: 2, returned: false },
      { p: -1, returned: true },
    ];
    assert.equal(fitCloseWatchP(weird), 0.3);
  });

  it("el vigilante corre la calibración tras el gate de cadencia", () => {
    const svc = readFileSync(join(__dirname, "..", "lib", "profile-recalibrate", "service.ts"), "utf8");
    assert.ok(svc.includes("calibrateCloseWatchP"), "service no calibra el corte");
    assert.ok(
      svc.includes("close_watch_p") || svc.includes("close-watch"),
      "service no menciona la calibración en logs/razón",
    );
  });

  it("el default documentado sigue existiendo como fallback", () => {
    assert.equal(CLOSE_WATCH_DEFAULT_P, 0.1);
    assert.ok(CLOSE_WATCH_FIT_MIN_SAMPLES >= 20, "mínimo de muestras demasiado bajo");
  });
});
