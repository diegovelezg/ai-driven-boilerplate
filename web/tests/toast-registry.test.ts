// Registro del canal único de toasts (MO): qué actions van a la cinta con
// corrida, cuáles avisan instantáneo, y las invariantes que impiden_TOASTS_
// clavados o silenciosos ante cambios y toasts nuevos.
// Corre con: npm test (node:test vía tsx).
//
// Cómo clasificar una action nueva: agrégala a RUNNING (devuelve `run` y su
// caller la envuelve en `bg.start()`) o a INSTANT (sub-segundo: inline o
// `toast.add` basta). Si el test falla con "no registrada", es a propósito:
// decide el canal antes de mergear.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** Actions con corrida en `background_runs`: el caller VA a la cinta. */
const RUNNING = new Set([
  "startCopywriterAction",
  "syncCustomersAction",
  "proposeSingleAction",
  "approveBatchAction",
  "regenerateStaleDraftsAction",
  "runRecalibrationAction",
  "saveConnectionsAction",
  "startEnrichmentAction",
  "reenrichDomainAction",
  "triggerProspectAction",
  "runProfilerAction", // set con corrida `profile` (progreso por etapa) + síntesis síncrona
]);

/** Actions instantáneas (sin run): inline o `toast.add` basta. */
const INSTANT = new Set([
  "approveActionAction",
  "rejectActionAction",
  "rejectLeadAction",
  "markLeadContactedAction",
  "reopenLeadAction",
  "dismissSignalAction",
  "getCustomerSignalAction",
  "reopenSignalAction",
  "reopenCustomerSignalAction",
  "markDispatchedAction",
  "switchChannelAction",
  "updateDraftContentAction",
  "revokeApprovalAction",
  "reopenActionAction",
  "optOutCustomerAction",
  "optInCustomerAction",
  "getDrawerCustomerAction",
  "decideProfileDeltaAction",
  "chatProfileStepAction",
  "saveEmailAction",
  "testEmailAction",
  "revokeSecretAction",
  "saveTenantProfileAction",
  "updateCustomerAction",
  "mergeAllDuplicatesAction",
  "mergeCustomersAction",
  "signInAction",
  "signOutAction",
  "getActiveRunsAction", // poll de la cinta, no mutación
]);

/** Módulos lib que exportan server actions consumidas por clientes. */
const ACTION_MODULES = new Set([
  "lib/review-actions",
  "lib/retention-actions",
  "lib/sync-actions",
  "lib/enrich-actions",
  "lib/settings-actions",
  "lib/profile-actions",
  "lib/profile-recalibrate/actions",
  "lib/customer-actions",
  "lib/auth-actions",
  "lib/background-actions",
  "lib/merge-actions",
]);

function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        if (e === "node_modules" || e === ".next") continue;
        walk(p);
      } else if (/\.(tsx?|ts)$/.test(e)) {
        out.push(p);
      }
    }
  };
  for (const d of ["app", "components", "hooks"]) {
    try {
      walk(join(ROOT, d));
    } catch {
      // hooks/ puede no existir: no es error.
    }
  }
  return out;
}

/** Nombres `*Action` importados desde módulos de actions (multilínea OK). */
function importedActions(source: string): string[] {
  const out = new Set<string>();
  const re = /from\s*"@\/([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (!ACTION_MODULES.has(m[1])) continue;
    const start = source.lastIndexOf("import", m.index);
    const block = source.slice(start < 0 ? 0 : start, m.index + m[0].length);
    for (const t of block.matchAll(/[A-Za-z]+Action/g)) out.add(t[0]);
  }
  return [...out];
}

describe("canal único: sin updates ni stickies fuera de la cinta", () => {
  it("toast.update solo vive en background-status (huella anti reschedule)", () => {
    const bad = clientFiles().filter((f) => {
      if (f.endsWith("components/background-status.tsx")) return false;
      return readFileSync(f, "utf8").includes("toast.update(");
    });
    assert.deepEqual(bad, [], `toast.update fuera de la cinta (reinicia auto-hide): ${bad.join(", ")}`);
  });

  it("timeout: 0 solo en la cinta (ningún toast nuevo clavado)", () => {
    // Excepción auditada: profile-chat conserva el loading manual SOLO para
    // el fallback sin cinta (fuera del dashboard): cierre EXPLÍCITO en
    // `finally`, sin update/reschedule. Con cinta, el progreso va por la
    // corrida `profile` y no hay toast propio.
    const ALLOW_STICKY = new Set(["components/profile-chat.tsx"]);
    const bad = clientFiles().filter((f) => {
      if (f.endsWith("components/background-status.tsx")) return false;
      if ([...ALLOW_STICKY].some((a) => f.endsWith(a))) return false;
      return /timeout:\s*0/.test(readFileSync(f, "utf8"));
    });
    assert.deepEqual(bad, [], `sticky fuera de la cinta: ${bad.join(", ")}`);
  });

  it("todo toast.add lleva type explícito (contrato del icono)", () => {
    const bad: string[] = [];
    for (const f of clientFiles()) {
      const s = readFileSync(f, "utf8");
      let i = 0;
      while ((i = s.indexOf("toast.add(", i)) >= 0) {
        // Ventana amplia: el `description` JSX puede ser largo; el `type`
        // admite ternaria (p. ej. r.ok ? "success" : "error") o spread de un
        // `options` construido con type (patrón de la cinta).
        const window = s.slice(i, i + 2000);
        if (!/type:\s*("|\w)|\.\.\.options/.test(window)) {
          bad.push(`${f}@${i}`);
        }
        i += 10;
      }
    }
    assert.deepEqual(bad, [], `toast.add sin type: ${bad.join(", ")}`);
  });

  it("todo `type` usado pertenece al set oficial (doc shadcn base/toast)", () => {
    // La doc oficial solo reconoce success, info, warning, error y loading;
    // otro literal no renderiza icono y rompe el contrato visual. Solo se
    // inspeccionan llamadas toast (el `type:` de Button/variant no cuenta).
    const OFFICIAL = new Set(["success", "info", "warning", "error", "loading"]);
    // Expresión del `type:` hasta la coma/cierre de mismo nivel (cubre
    // literal, ternaria simple y el ternario multilínea de la cinta).
    const typeExpr = (s: string, from: number): string => {
      let depth = 0;
      let quote: string | null = null;
      let i = from;
      for (; i < s.length; i++) {
        const c = s[i];
        if (quote) {
          if (c === quote && s[i - 1] !== "\\") quote = null;
          continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
          if (depth === 0) break;
          depth--;
        } else if (c === "," && depth === 0) break;
      }
      return s.slice(from, i);
    };
    const bad: string[] = [];
    for (const f of clientFiles()) {
      const s = readFileSync(f, "utf8");
      let i = 0;
      while (true) {
        const a = s.indexOf("toast.add(", i);
        const u = s.indexOf("toast.update(", i);
        if (a < 0 && u < 0) break;
        i = Math.min(a < 0 ? Infinity : a, u < 0 ? Infinity : u);
        const window = s.slice(i, i + 2000);
        const t = window.indexOf("type:");
        // Spread (...options): el type vive en el options auditado, sin
        // literales a la vista.
        if (t >= 0) {
          const expr = typeExpr(window, t + "type:".length);
          const lits = [...expr.matchAll(/"([a-z]+)"|'([a-z]+)'/g)].map((m) => m[1] ?? m[2]);
          for (const lit of lits) {
            if (!OFFICIAL.has(lit)) bad.push(`${lit} en ${f}@${i}`);
          }
        }
        i += 10;
      }
    }
    assert.deepEqual(bad, [], `type fuera del set oficial: ${bad.join(", ")}`);
  });

  it("el sync a toasts salta payloads idénticos (auto-hide no se resetea)", () => {
    const s = readFileSync(join(ROOT, "components/background-status.tsx"), "utf8");
    assert.ok(s.includes("lastToastKeyRef"), "falta la huella: cada poll re-emite y clava el listo");
  });
});

describe("registro: toda action de cliente tiene canal asignado", () => {
  it("ninguna action sin registrar (ni nueva ni movida)", () => {
    const unknown: string[] = [];
    for (const f of clientFiles()) {
      const s = readFileSync(f, "utf8");
      for (const a of importedActions(s)) {
        if (!RUNNING.has(a) && !INSTANT.has(a)) unknown.push(`${a} en ${f}`);
      }
    }
    assert.deepEqual(
      unknown,
      [],
      `actions sin canal: registra en RUNNING o INSTANT → ${unknown.join(" / ")}`,
    );
  });

  it("toda RUNNING se invoca envuelta en bg.start()/start()", () => {
    const bad: string[] = [];
    for (const f of clientFiles()) {
      const s = readFileSync(f, "utf8");
      const mentions = [...RUNNING].filter((a) => s.includes(a));
      if (mentions.length === 0) continue;
      if (!/(bg\.start\(|[^A-Za-z_]start\()/.test(s)) {
        bad.push(`${mentions.join(",")} en ${f}`);
      }
    }
    assert.deepEqual(bad, [], `RUNNING sin cinta: ${bad.join(" / ")}`);
  });
});
