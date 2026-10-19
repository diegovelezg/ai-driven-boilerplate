export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Dato estructurado de una tool (list_actions, list_signals, list_leads,
 *  get_store_summary, filter_customers): se pinta en el canvas, no en las burbujas.
 *  `query` son los args con los que el agente llamó a la tool (limit,
 *  channel…; en filter_customers: q/decision/vista/ritmo/customer_type):
 *  el canvas los usa como estado inicial de sus filtros. */
export interface ChatArtifact {
  tool: string;
  data: unknown;
  query?: {
    limit?: number;
    channel?: string;
    status?: string;
    q?: string | null;
    decision?: string | null;
    vista?: string | null;
    ritmo?: string | null;
    customer_type?: string | null;
    customerType?: string | null;
  } | null;
}
