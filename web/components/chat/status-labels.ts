/** Etiquetas del "pensando" descriptivo: tool de dooh_agent → qué se muestra.
 *  SSOT visual: solo ChatShell las pinta. Solo las 6 tools vivas del agente único. */
const TOOL_STATUS: Record<string, string> = {
  get_company: "Leyendo la ficha de la empresa…",
  get_order: "Revisando la orden…",
  get_screen: "Revisando la pantalla…",
  search_inventory: "Buscando pantallas disponibles…",
  get_finance: "Calculando finanzas…",
  explain_kpi: "Explicando el indicador…",
};

/** Tool desconocida → genérico honesto (sigue habiendo trabajo en curso). */
export function toolStatusLabel(tool: string): string {
  return TOOL_STATUS[tool] ?? "Consultando tus datos…";
}
