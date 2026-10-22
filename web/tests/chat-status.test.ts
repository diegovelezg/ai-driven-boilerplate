// Guardián del "pensando" descriptivo.
// Corre con: npm test (node:test vía tsx).
// Regla: el estado de espera muestra QUÉ hace el orquestador (tool en curso
// vía SSE → etiqueta en status-labels), no un genérico fijo. El perfil
// (server actions, sin SSE) rota etapas locales y las pasa por `status`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolStatusLabel } from "@/components/chat/status-labels";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("pensando descriptivo", () => {
  it("los especialistas delegados nombran al agente real", () => {
    assert.match(toolStatusLabel("start_scout_run"), /Scout/);
    assert.match(toolStatusLabel("start_strategist_run"), /Estratega/);
    assert.match(toolStatusLabel("start_copywriter_run"), /Redactor/);
    assert.match(toolStatusLabel("start_dispatcher_run"), /Mensajero/);
    assert.match(toolStatusLabel("start_analyst_run"), /Analista/);
    assert.match(toolStatusLabel("start_prospect_run"), /Prospector/);
  });

  it("las tools de datos describen la acción y terminan en …", () => {
    for (const t of [
      "list_actions",
      "list_leads",
      "filter_customers",
      "get_store_summary",
      "get_customer_orders",
      "get_product_summary",
      "get_product_buyers",
    ]) {
      const label = toolStatusLabel(t);
      assert.ok(label.length > 0, `sin etiqueta: ${t}`);
      assert.ok(label.endsWith("…"), `sin elipsis: ${t} → ${label}`);
    }
  });

  it("tool desconocida → genérico honesto", () => {
    assert.equal(toolStatusLabel("no_existe"), "Consultando tus datos…");
  });

  it("las 3 rutas SSE emiten status en cada functionCall", () => {
    for (const r of [
      "app/api/chat/route.ts",
      "app/api/customers/[id]/chat/route.ts",
      "app/api/products/[id]/chat/route.ts",
    ]) {
      const src = read(r);
      assert.ok(src.includes("statusSse("), `${r} no emite status`);
      assert.ok(src.includes("{ status:"), `${r} sin evento {status}`);
    }
  });

  it("el transporte parsea status, etiqueta y apaga en el primer token", () => {
    const src = read("components/chat/sse.ts");
    assert.ok(src.includes("status?:"), "SseEvent no acepta status");
    assert.ok(src.includes("toolStatusLabel"), "no mapea tool → etiqueta");
    assert.ok(src.includes("onStatus?.(null)"), "no apaga el estado al llegar tokens");
    const hook = read("components/chat/use-stream-chat.ts");
    assert.ok(hook.includes("status"), "el hook no expone status");
  });

  it("el shell prefiere status sobre thinkingLabel; el perfil rota etapas", () => {
    const shell = read("components/chat/chat-shell.tsx");
    assert.ok(shell.includes("status?:"), "ChatShell sin prop status");
    assert.ok(shell.includes("status ?? thinkingLabel"), "status no reemplaza a thinkingLabel");
    const profile = read("components/profile-chat.tsx");
    assert.ok(profile.includes("status={"), "el perfil no pasa status al shell");
    assert.ok(
      profile.includes("INVESTIGATING_STAGES") && profile.includes("GENERATING_STAGES"),
      "el perfil no distingue investigar vs generar",
    );
  });
});
