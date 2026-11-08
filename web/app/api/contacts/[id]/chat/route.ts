// Chat del drawer de contacto: agente con foco en el contacto.
// SSOT del handler en lib/api/chat-route.ts.
import { createChatRoute } from "@/lib/api/chat-route";

export const POST = createChatRoute({ scope: "contact" });
