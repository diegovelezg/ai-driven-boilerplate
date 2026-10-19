// Sello de criterios del copywriter: los borradores sin este sello son de
// criterios viejos (v1 implícita, v2 plantilla) y se pueden regenerar. Módulo
// neutro (sin imports server) para poder compararlo desde Client Components.
export const COPYWRITER_GEN = "copywriter:v13:email-estructura";

/** ¿Este generator cuenta como criterios actuales? (null = v1 implícita). */
export function isFreshGenerator(gen: string | null | undefined): boolean {
  return String(gen ?? "") === COPYWRITER_GEN;
}

/** Formato retention:v1 ("ciclo ~Nd"); lo demás es legacy pre-retention
 *  ("media Nd") o razón ausente. Solo para desglose en mensajes. */
export function isV1SignalReason(reason: string | null | undefined): boolean {
  return /ciclo ~\d+d/i.test(String(reason ?? ""));
}
