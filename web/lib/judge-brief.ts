// Issue #23: criterio puro juez→redactor (módulo neutro, sin imports
// server, importable desde tests tsx y client components).
// Una sola noción temporal: reusable=false = el pasado solo reconoce.

/** Parseo puro del JSON del juez v4. Ausencia = true/true. */
export function parseJudgeResponse(raw: string): { contactable: boolean; reusable: boolean; reason: string } {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const contactable = parsed.contactable !== false;
  const reusable = parsed.reusable !== false;
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim().slice(0, 140)
      : contactable
        ? "sin motivo de no-contacto en el dossier"
        : "el juez no dio motivo";
  return { contactable, reusable, reason };
}

/** Modo del brief según el juez: continuidad o identidad. */
export function briefMode(reusable: boolean): "continuidad" | "identidad" {
  return reusable ? "continuidad" : "identidad";
}

/** Patrón en modo identidad: recuerdo en una frase, sin ordenar repetición. */
export function identityPatron(quien: string | null): string {
  return quien
    ? `IDENTIDAD: cliente de ${quien}. Tono: recuerdo en una frase, propuesta nueva desde la capacidad general`
    : "IDENTIDAD: sin patrón legible. Tono: propuesta nueva desde la capacidad general";
}

/** Jugada en modo identidad: capacidad general para un uso nuevo. */
export function identityJugada(): string {
  return "ofrecer su capacidad general para un uso nuevo hoy, con un ejemplo concreto, y preguntarle si quiere que se lo pase";
}
