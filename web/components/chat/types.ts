export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
