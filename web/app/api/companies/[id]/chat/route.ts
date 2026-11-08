// Chat del drawer de empresa: agente con foco en la empresa.
// SSOT del handler en lib/api/chat-route.ts.
import { createChatRoute } from "@/lib/api/chat-route";

export const POST = createChatRoute({ scope: "company" });
