// Guardián del MO único: toda mutación larga va a la cinta global de toasts
// (`useBackground().start()` + run en `background_runs`); los guardados
// instantáneos de settings avisan por el mismo Toaster, no solo inline.
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("re-redactar del inbox con corrida visible", () => {
  it("regenerateStaleDraftsAction crea run 'regenerate' con progreso", () => {
    const s = src("lib/review-actions.ts");
    assert.ok(
      s.includes('startRun(storeId, "regenerate"'),
      "sin startRun regenerate: el scan vuelve a ser invisible",
    );
    assert.ok(s.includes("advanceRun("), "sin advanceRun: la cinta no muestra progreso");
    assert.ok(s.includes("setRunTotal("), "sin setRunTotal: el % queda en 0/0");
  });

  it("el regenerate se cierra antes del copywriter (incompatibles)", () => {
    const s = src("lib/review-actions.ts");
    const regenClose = s.indexOf("Cierre del regenerate antes del copywriter");
    const copyStart = s.indexOf("await startCopywriterAction()");
    assert.ok(regenClose >= 0 && copyStart > regenClose, "orden roto: regenerate running frena al copywriter");
  });
});

describe("revisión de perfil en la cinta", () => {
  it("runRecalibrationAction devuelve el run al instante", () => {
    const s = src("lib/profile-recalibrate/actions.ts");
    assert.ok(s.includes("run?: BackgroundRun | null"), "RecalibrateState sin run: el cliente no puede ir a la cinta");
    assert.ok(
      s.includes('startRun(storeId, "recalibrate"'),
      "sin startRun previo: el run nace en after() y el toast nunca lo ve",
    );
  });

  it("ProfileProposalsPanel pasa por bg.start()", () => {
    const s = src("components/profile-proposals.tsx");
    assert.ok(s.includes("bg.start("), "sin bg.start(): sin polling ni toast de progreso");
    assert.ok(!s.includes("recarga la página"), "copy viejo: ahora el progreso se sigue abajo a la derecha");
  });
});

describe("auto-hide de terminados no se reinicia", () => {
  it("el sync a toasts salta payloads idénticos", () => {
    const s = src("components/background-status.tsx");
    assert.ok(
      s.includes("lastToastKeyRef"),
      "sin huella por toast: cada poll re-emite update y el auto-hide nunca cuenta",
    );
    const hits = s.split("\n").filter((ln) => ln.includes("sent.get(id) === key"));
    assert.ok(hits.length >= 2, `el skip debe cubrir running y cierre, hay ${hits.length}`);
  });
});

describe("settings por el canal único de toasts", () => {
  it("el connect corre el sync en background (sin cola, directo)", () => {
    const s = src("lib/settings-actions.ts");
    assert.ok(
      s.includes("runSyncOnce(storeId"),
      "connect sin runSyncOnce: el sync vuelve a bloquear el submit sin progreso",
    );
    assert.ok(s.includes("after("), "sync sin after(): bloquea la respuesta en vez de ir a background");
    assert.ok(!s.includes("enqueueJob"), "quedó enqueue: la cola está fuera");
  });

  it("sin cola: ningún caller encola y el worker no hace poll", () => {
    for (const p of ["lib/sync-actions.ts", "lib/auth-actions.ts", "lib/settings-actions.ts", "worker.ts"]) {
      const s = src(p);
      assert.ok(!s.includes("enqueueJob"), `${p} aún encola: la cola está fuera`);
      assert.ok(!s.includes("@/lib/jobs"), `${p} aún importa lib/jobs`);
    }
    const w = src("worker.ts");
    assert.ok(!w.includes("claimNextJob"), "worker aún hace poll: cron directo por tienda");
    assert.ok(w.includes("runSyncOnce") || w.includes("runMorningPipeline"), "worker sin pipeline directo");
  });

  it("SettingsForm envuelve en bg.start()", () => {
    const s = src("components/settings-form.tsx");
    assert.ok(s.includes("bg.start("), "SettingsForm sin bg.start(): el connect no llega a la cinta");
  });

  it("guardados instantáneos avisan por toast, no solo inline", () => {
    const settings = src("components/settings-form.tsx");
    const tenant = src("components/tenant-profile-form.tsx");
    assert.ok(settings.includes("toast.add("), "settings-form sin toast.add: email/revocar solo avisan inline");
    assert.ok(tenant.includes("toast.add("), "tenant-profile-form sin toast.add: el perfil solo avisa inline");
  });
});
