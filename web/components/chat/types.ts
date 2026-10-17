export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Badge orgánico: qué especialista respondió este turno (lo infiere el
   *  cliente desde la tool usada; null = tu equipo / orquestador). */
  via?: string | null;
}

/** Tool de datos → especialista que responde (badge sobre la burbuja).
 *  Sin artefacto el turno lo firma el orquestador ("Tu equipo"). */
export function agentBadgeForTool(tool: string): string | null {
  switch (tool) {
    case "list_signals":
      return "Scout";
    case "list_actions":
      return "Redactor";
    case "list_leads":
      return "Prospector";
    case "filter_customers":
      return "Estratega";
    default:
      return null;
  }
}

/** Dato estructurado de una tool (list_actions, list_signals, list_leads,
 *  get_store_summary): se pinta en el canvas, no en las burbujas.
 *  `query` son los args con los que el agente llamó a la tool (limit,
 *  channel…): el canvas los usa como estado inicial de sus filtros. */
export interface ChatArtifact {
  tool: string;
  data: unknown;
  query?: { limit?: number; channel?: string; status?: string } | null;
}
