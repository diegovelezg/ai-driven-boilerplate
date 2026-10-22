/** Etiquetas del "pensando" descriptivo: tool del orquestador → qué se muestra.
 *  Los `start_*_run` son delegación real a un especialista (Scout, Estratega,
 *  Redactor, Mensajero, Analista en `lib/adk/tools/retain-tools`); el resto
 *  describe la acción sobre datos. SSOT visual: solo ChatShell las pinta. */
const TOOL_STATUS: Record<string, string> = {
  start_scout_run: "Scout vigilando tu base…",
  start_strategist_run: "Estratega priorizando…",
  start_copywriter_run: "Redactor redactando borradores…",
  start_dispatcher_run: "Mensajero enviando lo aprobado…",
  start_analyst_run: "Analista midiendo recupero…",
  start_prospect_run: "Prospector buscando leads…",
  list_actions: "Revisando acciones pendientes…",
  list_leads: "Buscando leads…",
  filter_customers: "Filtrando customers…",
  find_customer: "Buscando al customer…",
  get_store_summary: "Resumiendo tu tienda…",
  get_recovery_stats: "Midiendo recupero…",
  list_signals: "Revisando señales…",
  approve_actions: "Aprobando borradores…",
  reject_actions: "Descartando borradores…",
  get_customer_profile: "Leyendo la ficha…",
  get_customer_orders: "Revisando sus compras…",
  get_customer_firmographics: "Revisando datos de la empresa…",
  get_top_products: "Rankeando tu catálogo…",
  get_product_summary: "Leyendo la ficha del ítem…",
  get_product_movements: "Revisando cuándo se vende…",
  get_product_buyers: "Revisando quiénes lo compran…",
};

/** Tool desconocida → genérico honesto (sigue habiendo trabajo en curso). */
export function toolStatusLabel(tool: string): string {
  return TOOL_STATUS[tool] ?? "Consultando tus datos…";
}
