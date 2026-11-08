// Auditoría del single "Redactar" (issue #16 Fase 1). Módulo puro y
// testeable (sin I/O): la regla de cierre garantizado vive aquí, no en el
// server action. (HISTÓRICO: el productor de vetos del motor extirpado vivía
// en el redactor; hoy el prefijo lo define este módulo y nadie más lo emite.)
// Sin `server-only`: lo importan el test tsx y un client component.
import type { ErrorCode, ScopeKind } from "@/lib/operations";

export const JUDGE_VETO_PREFIX = "Omitido por el juez";

/** Scope del single (una señal): ÚNICA fuente usada tanto por el
 *  pre-check de conflicto como por el `startRun` que persiste el run. Si
 *  divergen, el segundo single sobre la misma señal no conflicta en prod. */
export function singleSignalScope(signalId: string): { scopeKind: ScopeKind; scopeId: string } {
  return { scopeKind: "signal", scopeId: signalId };
}

/** ¿Este mensaje es un veto del juez (y no un fallo)? Todo productor de vetos
 *  (HISTÓRICO: el redactor extirpado) debe pasar por `JUDGE_VETO_PREFIX`,
 *  nunca por literales duplicados en cada consumidor. */
export function isJudgeVetoMessage(msg: string): boolean {
  return msg.startsWith(JUDGE_VETO_PREFIX);
}

export interface SingleResult {
  ok: boolean;
  message: string;
}

export interface SingleFinish {
  status: "done" | "error";
  processed: number;
  failed: number;
  summary: string | null;
  error: string | null;
  pulseState: "needs" | "paused" | null;
  /** Cierre tipado (Fase 0): el veto viaja como `judge_veto`, no como texto. */
  errorCode: ErrorCode | null;
}

export interface SingleRunDeps {
  start: () => Promise<string | null>;
  advance: (runId: string) => Promise<void>;
  finish: (runId: string, f: SingleFinish) => Promise<void>;
  draft: () => Promise<SingleResult>;
}

/** Clasifica el cierre del run: éxito → needs; veto → done/paused sin
 *  failed (omisión auditada, no fallo); resto → error con failed. */
export function classifySingleFinish(r: SingleResult): SingleFinish {
  if (r.ok) {
    return { status: "done", processed: 1, failed: 0, summary: r.message, error: null, pulseState: "needs", errorCode: null };
  }
  if (isJudgeVetoMessage(r.message)) {
    return { status: "done", processed: 0, failed: 0, summary: r.message, error: null, pulseState: "paused", errorCode: "judge_veto" };
  }
  return { status: "error", processed: 0, failed: 1, summary: null, error: r.message, pulseState: null, errorCode: null };
}

function errorFinish(message: string): SingleFinish {
  return { status: "error", processed: 0, failed: 1, summary: null, error: message, pulseState: null, errorCode: null };
}

/** Ejecuta el draft con auditoría `copywriter_single`. Garantía P0: el run
 *  SIEMPRE queda cerrado — si `draft` lanza (mira, lookup, queries `busy`,
 *  LLM), se cierra en `error` y se devuelve el mensaje en vez de propagar.
 *  Nunca rechaza por causa del draft; cada paso de auditoría tolera su
 *  propio fallo para no romper el flujo principal. */
export async function runSingleWithAudit(deps: SingleRunDeps): Promise<SingleResult> {
  let runId: string | null = null;
  try {
    runId = await deps.start();
  } catch {
    runId = null;
  }
  if (runId) {
    try {
      await deps.advance(runId);
    } catch {
      // Auditoría best-effort: el log vive en el wiring (server).
    }
  }
  try {
    const r = await deps.draft();
    if (runId) {
      try {
        await deps.finish(runId, classifySingleFinish(r));
      } catch {
        // Idem: no romper el resultado por la auditoría.
      }
    }
    return r;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (runId) {
      try {
        await deps.finish(runId, errorFinish(message));
      } catch {
        // Último recurso: el run ya se intentó cerrar; no hay más vía.
      }
    }
    return { ok: false, message };
  }
}
