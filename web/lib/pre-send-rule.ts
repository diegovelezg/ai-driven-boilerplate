// Regla pura de pre-envío (issue #13): decide con hechos, sin IO.
// Módulo sin imports (apto para tests y Client Components): el gate con BD
// vive en `lib/pre-send.ts`, que re-exporta esto.
// Semántica:
// - skip (terminal, status `skipped` + motivo en evidence_json.skip):
//   opt-out, recompra tras aprobar, señal descartada, otro envío reciente.
// - hold (no terminal, queda `approved` sin auto-envío): juez fail-open,
//   predicción vigente no-enviable. Lo decide un humano (revocar en Review).

export type SkipCode =
  | "opt_out"
  | "repurchased"
  | "signal_dismissed"
  | "contactado_reciente";
export type HoldCode = "fail_open" | "stale_prediction";
export type PreSendResult =
  | { send: true }
  | { send: false; terminal: boolean; code: SkipCode | HoldCode; message: string };

/** Decisiones del motor que admiten envío (foto vigente). */
export const SENDABLE_DECISIONS: ReadonlySet<string> = new Set([
  "actuar",
  "revision_humana",
  "vigilar",
]);

/**
 * Regla pura de pre-envío. Orden de prioridad (el primero que frena manda):
 * opt-out > recompra > descarte > contacto reciente > fail-open > predicción.
 * `predictionSendable=null` = sin foto vigente conocida: no frena por eso
 * (no se castiga la falta de dato, solo el dato en contra).
 */
export function evaluatePreSend(input: {
  optedOut: boolean;
  repurchasedSinceApproval: boolean;
  signalDismissed: boolean;
  contactedRecentlyElsewhere: boolean;
  failOpen: boolean;
  predictionSendable: boolean | null;
}): PreSendResult {
  if (input.optedOut) {
    return { send: false, terminal: true, code: "opt_out", message: "Baja del destinatario (opt-out): nunca enviable por este canal." };
  }
  if (input.repurchasedSinceApproval) {
    return { send: false, terminal: true, code: "repurchased", message: "El cliente volvió a comprar tras aprobar: ya no necesita el mensaje." };
  }
  if (input.signalDismissed) {
    return { send: false, terminal: true, code: "signal_dismissed", message: "La señal se descartó tras aprobar: el humano la juzgó irrelevante." };
  }
  if (input.contactedRecentlyElsewhere) {
    return { send: false, terminal: true, code: "contactado_reciente", message: "Otro mensaje salió para este cliente tras aprobar: no duplicar." };
  }
  if (input.failOpen) {
    return { send: false, terminal: false, code: "fail_open", message: "Juez de contactabilidad en fail-open: requiere ojo humano, sin auto-envío." };
  }
  if (input.predictionSendable === false) {
    return { send: false, terminal: false, code: "stale_prediction", message: "La foto vigente del motor ya no lo marca enviable: revisar antes de enviar." };
  }
  return { send: true };
}
