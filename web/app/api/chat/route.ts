// Chat único: el orquestador (customer_agent generalista) decide qué
// especialista invocar por turno. El user nunca elige agente: es orgánico.
// Fase 2: agente DOOH en construcción (501 honesto hasta que aterrice).
// SSOT del esqueleto en lib/api/chat-route.ts (issue #8 P2).
import { createChatRoute } from "@/lib/api/chat-route";

export const POST = createChatRoute();
