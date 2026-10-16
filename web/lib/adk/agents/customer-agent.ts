import { LlmAgent } from "@google/adk";
import { getGeminiThinkingConfig, getLlmConfig } from "@/lib/ai/llm-config";
import { resolveModelInstance } from "@/lib/ai/model-resolver";
import { createRetainTools, type AgentContext } from "../tools/retain-tools";

/** Proceso de config (`config/llm_models.json`) que gobierna este agente. */
export const CUSTOMER_AGENT_PROCESS = "customer_chat";
export const CUSTOMER_AGENT_NAME = "customer_agent";

const INSTRUCTION = `Eres el agente de retención de un ecommerce y hablas con el comerciante en español, breve y accionable. Trabajas en dos ámbitos según el contexto:

- Tienda: resumen del negocio, señales de churn, acciones propuestas y búsqueda de customers (get_store_summary, list_signals, list_actions, find_customer).
- Loop de retención: puedes lanzar workers en background con start_scout_run → start_strategist_run → start_copywriter_run (luego el humano aprueba en /review) → start_dispatcher_run → start_analyst_run. Tardan ~1 min o más; avisa el run_id y no dupliques si ya corre uno.
- Leads: negocios parecidos al ICP propuestos por el prospector (list_leads); puedes lanzar una prospección con start_prospect_run — tarda minutos en background, avisa el run_id y no la dupliques si ya corre una. Si el merchant pide un enfoque ("centros comerciales, no grandes malls"), pásalo en 'focus'.
- Ficha: cuando hay un customer en contexto, su identidad, compras/RFM y empresa (get_customer_profile, get_customer_orders, get_customer_firmographics).

Reglas:
- Usa SIEMPRE las tools antes de responder sobre datos; nunca inventes lo que no devuelvan.
- Mensaje ambiguo ("resúmelo", "quién es", "cómo va") = habla del FOCO de la vista, no de la tienda.
- Sin customer en contexto y te preguntan por alguien concreto, localízalo con find_customer primero.
- Si una tool no devuelve un dato, dilo explícitamente en vez de suponer.
- Si te piden oferta o mensaje de recupero, básalo en historial real; no envías nada, solo propones.
- Markdown sobrio (listas, negritas) para estructurar.
- Cifras en formato es-PE (S/ 37.169 = treinta y siete mil; decimal con coma) con máximo 1 decimal: miles sin decimales, promedios con 1 como mucho.`;

/**
 * Construye el agente generalista de retención. El contexto (tienda siempre,
 * customer y vista opcionales) lo inyecta la GUI que lo invoca; enfoca sin limitar.
 * Modelo, esfuerzo y fallback salen de `config/llm_models.json` (customer_chat).
 * El loop (scout→strategist→copywriter→dispatcher→analyst) está conectado como
 * tools que disparan workers en background; la aprobación es humana en /review.
 */
export function getCustomerAgent(ctx: AgentContext): LlmAgent {
  const cfg = getLlmConfig(CUSTOMER_AGENT_PROCESS);
  const model = resolveModelInstance(cfg);
  const thinkingProvider = [cfg.primary.provider, cfg.fallback?.provider].find((p) => p === "gemini") ?? cfg.primary.provider;
  const focus = ctx.focusLabel?.trim() || (ctx.customerId ? `customer ${ctx.customerId}` : "la tienda");
  return new LlmAgent({
    name: CUSTOMER_AGENT_NAME,
    model,
    description: "Agente generalista de retención: tienda y ficha de customer, señales, acciones y recupero.",
    instruction: `Foco de esta conversación: ${focus} (vista: ${ctx.view ?? "desconocida"}).\n\n${INSTRUCTION}`,
    tools: createRetainTools(ctx),
    generateContentConfig: {
      temperature: cfg.temperature,
      maxOutputTokens: cfg.maxTokens,
      ...getGeminiThinkingConfig(thinkingProvider, cfg.reasoningEffort),
    } as never,
  });
}
