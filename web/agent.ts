import { getCustomerAgent } from "@/lib/adk/agents/customer-agent";

// Entrypoint para `@google/adk-devtools` (adk web / adk run).
// Contexto generalista: ADK_DEV_CUSTOMER_ID fija la ficha (opcional),
// ADK_DEV_STORE_ID la tienda (requerida para el ámbito tienda).
// Ej.: ADK_DEV_STORE_ID=<uuid> ADK_DEV_CUSTOMER_ID=<uuid> npm run adk
const storeId = process.env.ADK_DEV_STORE_ID ?? null;
const customerId = process.env.ADK_DEV_CUSTOMER_ID ?? null;

if (!storeId) {
  console.warn(
    "[agent] ADK_DEV_STORE_ID no definido: las tools de tienda no tendrán ámbito. " +
      "Ej.: ADK_DEV_STORE_ID=<uuid> npm run adk",
  );
}

export const rootAgent = getCustomerAgent({ storeId, customerId, view: "adk" });
