// Matriz de compatibilidad de operaciones (issue #16, Fase 0). Módulo puro
// y testeable (sin I/O): decide qué puede correr contra qué, sin estados
// locales divergentes. El lock global grueso (`hasRunningRun` sin filtro)
// queda como caso particular: solo `sync` bloquea todo contra todo.
// Sin `server-only`: lo importan server actions, client components (cinta,
// botones) y tests tsx.
export type ScopeKind = "global" | "signal" | "customer" | "domain";

export type ErrorCode = "judge_veto" | "busy" | "llm_fail" | "stale" | "conflict";

/** Kinds con corrida en `background_runs`. Los instantáneos (`approve`,
 *  `reject`, `dismiss`) no crean run: no participan del lock. */
export type OperationKind =
  | "sync"
  | "enrichment"
  | "enrich_single"
  | "scout"
  | "strategist"
  | "copywriter"
  | "copywriter_single"
  | "regenerate"
  | "dispatcher"
  | "analyst"
  | "prospect"
  | "profiler"
  | "approve_batch"
  | "approve"
  | "reject"
  | "dismiss";

export interface ActiveOp {
  kind: string;
  scopeKind: ScopeKind;
  scopeId: string | null;
  label: string;
}

export interface NewOp {
  kind: string;
  scopeKind?: ScopeKind;
  scopeId?: string | null;
}

/** Cadena secuencial del loop (misma piscina de señales). */
const CHAIN = new Set(["scout", "strategist", "copywriter"]);

/** Kinds que nunca duplican corrida de sí mismos. */
const LONE = new Set(["dispatcher", "analyst", "prospect", "profiler", "enrichment", "regenerate"]);

/** ¿Estas dos operaciones son incompatibles (no pueden correr a la vez)? */
export function conflictsWith(aNew: NewOp, bActive: ActiveOp): boolean {
  const a = aNew.kind;
  const b = bActive.kind;
  // `sync` bloquea todo (y todo bloquea `sync`).
  if (a === "sync" || b === "sync") return true;
  // Cadena secuencial: scout → strategist → copywriter.
  if (CHAIN.has(a) && CHAIN.has(b)) return true;
  // El bulk redacta la misma piscina que el single y que regenerate.
  if (a === "copywriter" && (b === "copywriter_single" || b === "regenerate")) return true;
  if (b === "copywriter" && (a === "copywriter_single" || a === "regenerate")) return true;
  if ((a === "copywriter_single" && b === "regenerate") || (a === "regenerate" && b === "copywriter_single")) {
    return true;
  }
  if (a === "regenerate" && b === "regenerate") return true;
  // Puntuales: solo contra su misma unidad (una señal, un dominio).
  if (a === "copywriter_single" && b === "copywriter_single") {
    return (aNew.scopeId ?? null) !== null && aNew.scopeId === bActive.scopeId;
  }
  if (a === "enrich_single" && b === "enrich_single") {
    return (aNew.scopeId ?? null) !== null && aNew.scopeId === bActive.scopeId;
  }
  // El bulk de enriquecimiento cubre el dominio puntual.
  if ((a === "enrich_single" && b === "enrichment") || (a === "enrichment" && b === "enrich_single")) {
    return true;
  }
  // Sin duplicados del mismo worker pesado.
  if (a === b && LONE.has(a)) return true;
  return false;
}

/** ¿Esta operación puede arrancar contra los activos? */
export function isCompatible(nuevo: NewOp, activos: ActiveOp[]): boolean {
  return !activos.some((b) => conflictsWith(nuevo, b));
}

/** Primer activo incompatible (para nombrar el conflicto: `En curso: X…`). */
export function findConflict(nuevo: NewOp, activos: ActiveOp[]): ActiveOp | null {
  return activos.find((b) => conflictsWith(nuevo, b)) ?? null;
}

/** Mensaje humano de rechazo por lock (`En curso: Copywriter…`). */
export function conflictMessage(conflict: ActiveOp): string {
  return `En curso: ${conflict.label}…`;
}

/** `error_code` → lenguaje humano (la cinta nunca muestra el código crudo). */
export function errorCodeMessage(code: ErrorCode): string {
  switch (code) {
    case "judge_veto":
      return "Omitido por el juez";
    case "busy":
      return "En curso";
    case "llm_fail":
      return "Falló el modelo de lenguaje";
    case "stale":
      return "Se interrumpió (proceso colgado)";
    case "conflict":
      return "En curso";
  }
}
