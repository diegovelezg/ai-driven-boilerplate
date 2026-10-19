// Guardián anti-tormenta de refresh (ECONNRESET + parpadeo).
// Corre con: npm test (node:test vía tsx).
// Reglas:
// 1. Un solo `router.refresh()` por mutación: `BackgroundStatus.start()` ya
//    refresca al resolver; si el caller repite el refresh, el segundo aborta
//    el RSC en vuelo (Error: aborted / ECONNRESET) y la página parpadea.
//    Solo el host sin provider (canvas del chat, `bg === null`) refresca.
// 2. Los links del sidebar preservan el scope (?store=/?market=); sin suffix
//    cada navegación resetea el tenant y dispara navegación doble.
// 3. `ReviewLists` no se desmonta al cambiar de tab (`key={initialTab}`
//    tiraba edición/selección y parpadeaba); solo remonta con filtro del
//    chat o market nuevo.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Bloque de `export function <name>` o `const <name> = ... =>` hasta el siguiente export/function. */
function fnBlock(source: string, name: string): string {
  let start = source.indexOf(`function ${name}`);
  if (start < 0) start = source.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `no existe function/const ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\n(?:export function |const \w+ =|function \w+\()/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("un solo refresh por mutación", () => {
  it("attention-table: start() refresca, el caller no repite", () => {
    const s = src("app/(dashboard)/attention-table.tsx");
    assert.ok(s.includes("await start("), "debe pasar por BackgroundStatus.start()");
    assert.ok(!s.includes("router.refresh()"), "doble refresh: start() ya refrescó");
    assert.ok(!s.includes("useRouter"), "useRouter quedó sin uso");
  });

  it("review-lists approveSelected: refresh solo sin provider", () => {
    const s = src("app/(dashboard)/review/review-lists.tsx");
    assert.ok(s.includes("bg.start("), "debe pasar por bg.start() cuando hay provider");
    const hits = s.split("\n").filter((ln) => ln.includes("router.refresh()"));
    assert.equal(hits.length, 1, `un solo refresh en el archivo, hay ${hits.length}`);
    assert.ok(/if\s*\(!bg\)/.test(hits[0]), "ese refresh debe correr solo sin provider");
  });

  it("RegenerateButton: refresh solo sin provider", () => {
    const s = src("app/(dashboard)/review/review-buttons.tsx");
    const blk = fnBlock(s, "RegenerateButton");
    assert.ok(blk.includes("bg.start("), "debe pasar por bg.start() cuando hay provider");
    assert.ok(blk.includes("if (!bg) router.refresh()"), "el host sin provider sí debe refrescar");
    const bare = blk
      .split("\n")
      .filter((ln) => ln.includes("router.refresh()") && !ln.trim().startsWith("//"))
      .filter((ln) => !/if\s*\(!bg\)/.test(ln));
    assert.deepEqual(bare, [], `refresh incondicional junto a bg.start(): ${bare.join(" / ")}`);
  });
});

describe("scope persistente en sidebar", () => {
  it("ningún link del nav usa href bare sin suffix", () => {
    const s = src("components/app-sidebar.tsx");
    assert.ok(!s.includes("href={item.href}"), "el nav debe reinyectar ?store=/?market= (suffix)");
    assert.ok(s.includes("item.href}${suffix}") || s.includes("item.href}`"), "falta suffix en el href del nav");
  });
});

describe("ReviewLists sin remount por tab", () => {
  it("la key no depende del tab", () => {
    const code = src("app/(dashboard)/review/page.tsx")
      .split("\n")
      .filter((ln) => !ln.trim().startsWith("//") && !ln.trim().startsWith("*"))
      .join("\n");
    assert.ok(!code.includes("key={initialTab}"), "key={initialTab} desmonta todo en cada click de tab");
    assert.ok(code.includes("actionIds") && code.includes("leadIds") && code.includes("signalIds"),
      "la key debe derivar del filtro del chat (actionIds/leadIds/signalIds)");
  });
});
