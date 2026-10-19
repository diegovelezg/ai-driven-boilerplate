// Motivos cerrados para descartar señales (issue #8 Paso 2). Módulo puro
// (sin I/O ni "use server"): lo importan server actions, client components
// y tests. Vivía en `lib/review-actions.ts`, pero un archivo "use server"
// solo puede exportar funciones async — `export const` (objeto) rompe el
// dev con "A use server file can only export async functions, found object".
export const DISMISS_REASONS = [
  "contactado_fuera",
  "no_cliente_real",
  "dato_incorrecto",
  "otro",
] as const;

export type DismissReason = (typeof DISMISS_REASONS)[number];

export const DISMISS_REASON_LABEL: Record<DismissReason, string> = {
  contactado_fuera: "ya lo contacté por fuera",
  no_cliente_real: "no es cliente real",
  dato_incorrecto: "dato incorrecto",
  otro: "otro",
};

/** Normaliza el motivo del dismiss (null si libre/no reconocido). */
export function cleanDismissReason(reason: string | null | undefined): DismissReason | null {
  return reason && (DISMISS_REASONS as readonly string[]).includes(reason)
    ? (reason as DismissReason)
    : null;
}
