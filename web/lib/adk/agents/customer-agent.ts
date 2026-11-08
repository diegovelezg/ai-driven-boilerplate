import { LlmAgent } from "@google/adk";
import { getSupabase } from "@/lib/supabase";

export interface AgentContext {
  storeId: string | null;
  customerId?: string | null;
  companyId?: string | null;
  view?: string | null;
  focusLabel?: string | null;
}

export const CUSTOMER_AGENT_NAME = "dooh_agent";

/**
 * Agente DOOH Fase 2 (stub): responde sobre empresas, órdenes e inventario.
 * Sin loop de retención. Las tools pesadas (scout/prospect/copywriter) se
 * reintroducirán mapeadas a IOs cuando haya pipeline.
 */
export function getCustomerAgent(_ctx?: AgentContext) {
  return new LlmAgent({
    name: CUSTOMER_AGENT_NAME,
    description: "Asistente comercial DOOH: empresas, órdenes, inventario.",
    instruction:
      "Eres el asistente comercial DOOH. Respondes sobre empresas, órdenes de inserción, pantallas y marcas. Sin motor de retención: no hables de churn, predicciones ni winback.",
  });
}

export function createDoohTools(_ctx: AgentContext) {
  const db = () => getSupabase();
  return [
    {
      name: "count_companies",
      description: "Nº de empresas del tenant.",
      execute: async () => {
        if (!_ctx.storeId) return { error: "Sin tienda." };
        const { count } = await db().from("crm_companies").select("id", { count: "exact", head: true }).eq("store_id", _ctx.storeId);
        return { count: count ?? 0 };
      },
    },
  ];
}
