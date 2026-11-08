// Matriz de compatibilidad (Fase 2: sin pipeline programado).
// Se conserva el módulo por compatibilidad de imports: sin cadena
// secuencial ni workers pesados, nada conflicta con nada.
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

export function conflictsWith(_aNew: NewOp, _bActive: ActiveOp): boolean {
  return false;
}

export function isCompatible(_nuevo: NewOp, _activos: ActiveOp[]): boolean {
  return true;
}

export function findConflict(_nuevo: NewOp, _activos: ActiveOp[]): ActiveOp | null {
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
