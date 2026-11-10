// Prefijo canónico del veto del juez (issue #16 Fase 1). Todo productor de
// vetos debe pasar por `JUDGE_VETO_PREFIX`, nunca por literales duplicados
// en cada consumidor. (HISTÓRICO: el redactor extirpado emitía vetos; hoy el
// prefijo lo define este módulo y nadie más lo emite.)
// Sin `server-only`: lo importa un client component (background-status).

const JUDGE_VETO_PREFIX = "Omitido por el juez";

/** ¿Este mensaje es un veto del juez (y no un fallo)? */
export function isJudgeVetoMessage(msg: string): boolean {
  return msg.startsWith(JUDGE_VETO_PREFIX);
}
