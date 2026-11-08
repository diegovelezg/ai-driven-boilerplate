// Matriz de compatibilidad: dos corridas conflictan si comparten kind y
// solapan alcance (global choca con todo del mismo kind; scoped solo con
// mismo scopeKind+scopeId). Es el lock que impide duplicar trabajo concurrente.
export type ScopeKind = "global" | "signal" | "customer" | "domain";

export type ErrorCode = "judge_veto" | "busy" | "llm_fail" | "stale" | "conflict";

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

export function conflictsWith(aNew: NewOp, bActive: ActiveOp): boolean {
  if (aNew.kind !== bActive.kind) return false;
  const aScope = aNew.scopeKind ?? "global";
  const bScope = bActive.scopeKind ?? "global";
  // Global ocupa todo: choca con cualquier activo del mismo kind.
  if (aScope === "global" || bScope === "global") return true;
  // Scoped: solo si coinciden alcance e id.
  return aScope === bScope && (aNew.scopeId ?? null) === (bActive.scopeId ?? null);
}

export function isCompatible(nuevo: NewOp, activos: ActiveOp[]): boolean {
  return findConflict(nuevo, activos) === null;
}

export function findConflict(nuevo: NewOp, activos: ActiveOp[]): ActiveOp | null {
  for (const a of activos) {
    if (conflictsWith(nuevo, a)) return a;
  }
  return null;
}

export function conflictMessage(conflict: ActiveOp): string {
  return `En curso: ${conflict.label}…`;
}

export function busyMessage(conflict: ActiveOp): string {
  return conflictMessage(conflict);
}

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
