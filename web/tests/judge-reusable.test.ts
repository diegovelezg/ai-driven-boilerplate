// Issue #23: juez enriquecido (reusable) + brief condicional identidad.
// Corre con: npm test (node:test vía tsx, sin BD ni LLM).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJudgeResponse } from "@/lib/judge-brief";
import { briefMode, identityJugada, identityPatron } from "@/lib/judge-brief";
import { COPYWRITER_GEN, isFreshGenerator } from "@/lib/copywriter-gen";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p: string) => readFileSync(join(root, p), "utf-8");

describe("parseJudgeResponse (juez v4)", () => {
  it("caso Patricia: contactable true + reusable false", () => {
    const r = parseJudgeResponse(JSON.stringify({
      contactable: true,
      reusable: false,
      reason: "campaña pasada, sirve para reconocer",
    }));
    assert.equal(r.contactable, true);
    assert.equal(r.reusable, false);
  });

  it("ausencia = true/true (fail-open de criterio, no veto)", () => {
    const r = parseJudgeResponse(JSON.stringify({ reason: "x" }));
    assert.equal(r.contactable, true);
    assert.equal(r.reusable, true);
  });

  it("veto total se preserva", () => {
    const r = parseJudgeResponse(JSON.stringify({ contactable: false, reusable: false, reason: "nada útil" }));
    assert.equal(r.contactable, false);
  });

  it("reason se trunca a 140", () => {
    const r = parseJudgeResponse(JSON.stringify({ contactable: true, reusable: true, reason: "x".repeat(200) }));
    assert.ok(r.reason.length <= 140);
  });
});

describe("brief condicional (identidad vs continuidad)", () => {
  it("reusable=false → identidad, nunca CONTENIDO/REPITE", () => {
    assert.equal(briefMode(false), "identidad");
    const p = identityPatron("Podemos Perú");
    assert.match(p, /IDENTIDAD/);
    assert.doesNotMatch(p, /CONTENIDO|REPITE|continuidad de su línea/);
    assert.doesNotMatch(identityJugada(), /línea habitual|favorito habitual/);
    assert.match(identityJugada(), /capacidad general/);
  });

  it("reusable=true → continuidad", () => {
    assert.equal(briefMode(true), "continuidad");
  });
});

describe("prompts sin mierda: agnósticos y positivos", () => {
  it("sellos v4/v15 y frescura", () => {
    assert.match(src("lib/contactability.ts"), /JUDGE_GEN = "contactability:v4:reutilizable"/);
    assert.equal(COPYWRITER_GEN, "copywriter:v15:identidad-vs-intencion");
    assert.equal(isFreshGenerator(COPYWRITER_GEN), true);
    assert.equal(isFreshGenerator("copywriter:v14:uso-unico"), false);
  });

  it("juez no trae listas de categorías", () => {
    const j = src("lib/contactability.ts");
    for (const w of ["feria", "promo", "cumpleaños", "homenaje", "política", "Podemos"]) {
      assert.doesNotMatch(j, new RegExp(w, "i"), `juez con lista: ${w}`);
    }
  });

  it("copywriter SYSTEM positivo, sin PROHIBIDO-repetir ni meta-listas", () => {
    const c = src("lib/copywriter.ts");
    assert.match(c, /quién es, no qué necesita hoy/);
    assert.match(c, /nunca hables del mensaje/);
    assert.doesNotMatch(c, /PROHIBIDO proponer repetir/);
    assert.doesNotMatch(c, /uso único ya concluido/);
  });

  it("el brief por código bifurca por reusable", () => {
    const c = src("lib/copywriter.ts");
    assert.match(c, /briefMode\(verdict\.reusable\)/);
    assert.match(c, /mode === "identidad" \? identityPatron/);
  });
});
