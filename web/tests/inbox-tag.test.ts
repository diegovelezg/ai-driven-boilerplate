import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "..", "components", "inbox-tag.tsx"), "utf8");

function blockFor(key: string): string {
  const pat = key.endsWith(":") ? key : `${key}:`;
  const i = src.indexOf(pat);
  assert.ok(i >= 0, `falta meta para ${key}`);
  return src.slice(i, i + 600);
}

describe("inbox tags: color por criterio + tooltip humano", () => {
  it("kinds del inbox tienen label humano, color propio y tooltip", () => {
    for (const k of ["churn_risk", "vip_care", "winback", "nurture"]) {
      const b = blockFor(k);
      assert.ok(/label:\s*"/.test(b), `${k} sin label`);
      assert.ok(!b.includes(`label: "${k}"`), `${k} muestra snake_case crudo`);
      assert.ok(/bg-\w+-500\//.test(b), `${k} sin color bg-*/500`);
      assert.ok(/tip:\s*"/.test(b) && b.length > 50, `${k} sin tooltip`);
    }
  });

  it("canales mantienen el tratamiento whatsapp/email con tooltip", () => {
    assert.ok(blockFor("whatsapp").includes("bg-emerald-500/10"), "whatsapp pierde su verde");
    assert.ok(blockFor("email").includes("bg-sky-500/10"), "email pierde su sky");
  });

  it("cada kind usa un color distinto (no colisionan entre sí ni con canales)", () => {
    const colors = [...src.matchAll(/bg-(\w+)-500\//g)].map((m) => m[1]);
    const kinds = ["rose", "violet", "amber", "indigo"];
    for (const c of kinds) assert.ok(colors.includes(c), `falta color ${c}`);
    assert.equal(new Set(colors).size, colors.length, `colisión de colores: ${colors.join(",")}`);
  });

  it("review-lists ya no muestra kind/status en crudo", () => {
    const ui = readFileSync(
      join(__dirname, "..", "app", "(dashboard)", "review", "review-lists.tsx"),
      "utf8",
    );
    assert.ok(ui.includes("KindTag") && ui.includes("ChannelTag") && ui.includes("StatusTag"), "falta usar los tags");
    assert.ok(!ui.includes("{a.kind ? <span>{a.kind}</span>"), "sigue el span crudo de kind");
    assert.ok(!ui.includes("{s.status} · {s.kind}"), "sigue el texto crudo status · kind");
  });

  it("tag Hoy distingue lo generado hoy de la cola (isToday por día local)", async () => {
    const mod = await import("../components/inbox-tag");
    assert.equal(typeof mod.isToday, "function", "falta helper isToday");
    assert.ok(mod.isToday(new Date().toISOString()), "el ahora mismo debe ser hoy");
    assert.ok(!mod.isToday("2026-10-17T01:00:10.35881+00:00"), "un ISO de hace días no es hoy");
    assert.ok(!mod.isToday(null) && !mod.isToday("") && !mod.isToday("no-fecha"), "nulos/inválidos no son hoy");
    assert.ok(src.includes("TodayTag"), "falta componente TodayTag");
    const ui = readFileSync(
      join(__dirname, "..", "app", "(dashboard)", "review", "review-lists.tsx"),
      "utf8",
    );
    // Hoy en las 3 colas: mensajes (pending+approved), empresas y riesgo.
    const hoyUses = (ui.match(/<TodayTag value=\{/g) ?? []).length;
    assert.ok(hoyUses >= 5, `TodayTag debe usarse en mensajes, aprobadas, leads, señales y descartadas (hay ${hoyUses})`);
    assert.ok(ui.includes("<TodayTag value={l.created_at}"), "falta Hoy en empresas por contactar");
  });
});
