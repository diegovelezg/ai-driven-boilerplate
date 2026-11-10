// Guardia "nada nuevo con archivados": las órdenes nuevas o en borrador solo
// operan con contrapartes activas (facturador, agencia, 4 contactos).
// Lo ya firmado está cubierto por el snapshot inmutable de la NP.
// Puro y testeable (los actions aportan las filas con deleted_at + nombre).
export interface CounterpartyRef {
  /** Etiqueta para el mensaje (p. ej. "facturador", "firmante"). */
  label: string;
  archived: boolean;
  name?: string | null;
}

/** null = todas activas; si no, mensaje bloqueante con cómo desbloquear. */
export function archivedBlockerMessage(refs: CounterpartyRef[]): string | null {
  const hit = refs.filter((r) => r.archived);
  if (hit.length === 0) return null;
  const names = hit.map((h) => {
    const n = typeof h.name === "string" && h.name.trim() ? ` (${h.name.trim()})` : "";
    return `${h.label}${n}`;
  });
  const plural = hit.length > 1;
  return `${names.join(", ")} ${plural ? "archivados" : "archivado"}: restáuralo para operar con esta orden.`;
}
