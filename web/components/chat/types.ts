export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/** IDs estables para MessageScrollerItem (anclaje/scroll del nativo). */
export function createChatId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/** Dato estructurado de una tool (list_actions, list_leads, filter_customers:
 *  coincide con ARTIFACT_TOOLS en app/api/chat/route.ts): filtra la vista
 *  derecha (Review para actions/leads, Customers para filter), no las burbujas.
 *  `query` son los args con los que el agente llamó a la tool (limit,
 *  channel…; en filter_customers: q/decision/vista/ritmo/customer_type/
 *  ventana/banda/elegibilidad/decil): la vista los usa como filtros. */
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
    ventana?: string | null;
    banda?: string | null;
    elegibilidad?: string | null;
    decil?: string | null;
  } | null;
}
