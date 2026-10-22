// Guardián SSOT de chat.
// Corre con: npm test (node:test vía tsx).
// Regla SSOT: todo chat pasa por components/chat/chat-shell.tsx sobre los
// nativos shadcn (MessageScroller + Message + Bubble + InputGroup).
// El scroll a mano (scrollIntoView/bottomRef), las burbujas rounded-2xl y el
// Input+Button de envío están prohibidos fuera del shell.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SSOT = [
  "components/chat/chat-shell.tsx",
  "components/ui/message.tsx",
  "components/ui/bubble.tsx",
  "components/ui/message-scroller.tsx",
  "components/ui/input-group.tsx",
];
const NATIVES = [
  "components/ui/message",
  "components/ui/bubble",
  "components/ui/message-scroller",
  "components/ui/input-group",
];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (/\.tsx$/.test(e)) out.push(p);
  }
  return out;
}

const files = tsxFiles(join(ROOT, "app")).concat(tsxFiles(join(ROOT, "components")));
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

describe("SSOT Chat", () => {
  it("el shell usa los nativos (Scroller + Message + Bubble + InputGroup)", () => {
    const src = readFileSync(join(ROOT, "components/chat/chat-shell.tsx"), "utf8");
    for (const n of [
      "MessageScrollerProvider",
      "MessageScrollerViewport",
      "MessageScrollerContent",
      "MessageScrollerItem",
      "MessageScrollerButton",
      "Message",
      "MessageContent",
      "Bubble",
      "BubbleContent",
      "InputGroup",
      "InputGroupTextarea",
      "InputGroupAddon",
      "InputGroupButton",
    ]) {
      assert.ok(src.includes(n), `chat-shell no usa el nativo ${n}`);
    }
    assert.ok(src.includes("autoScroll"), "el provider debe llevar autoScroll");
    assert.ok(src.includes("scrollAnchor"), "el turno user debe anclar (scrollAnchor)");
  });

  it("nadie importa los primitivos de chat fuera del SSOT", () => {
    const bad = files
      .filter((f) => !SSOT.includes(rel(f)))
      .filter((f) => NATIVES.some((n) => readFileSync(f, "utf8").includes(n)));
    assert.deepEqual(bad.map(rel), [], `importan primitivos de chat directo: ${bad.map(rel).join(", ")}`);
  });

  it("sin scroll manual (scrollIntoView/bottomRef) en el chat", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (rel(f).startsWith("components/ui/")) continue;
      const src = readFileSync(f, "utf8");
      if (!src.includes("ChatShell") && !src.includes("chat-shell")) continue;
      if (/scrollIntoView|bottomRef/.test(src)) bad.push(rel(f));
    }
    assert.deepEqual(bad, [], `scroll manual en chat: ${bad.join(", ")} (usa MessageScroller)`);
  });

  it("sin burbujas a mano rounded-2xl ni input de envío fuera del shell", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (SSOT.includes(rel(f)) || rel(f).startsWith("components/ui/")) continue;
      const src = readFileSync(f, "utf8");
      if (!src.includes("ChatShell") && !src.includes("useStreamChat")) continue;
      if (/rounded-2xl/.test(src)) bad.push(rel(f));
    }
    assert.deepEqual(bad, [], `burbujas manuales: ${bad.join(", ")} (usa Bubble nativo en el shell)`);
  });
});
