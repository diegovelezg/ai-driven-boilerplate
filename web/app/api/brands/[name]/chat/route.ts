// Chat del drawer de marca: agente con foco en la marca.
// SSOT del handler en lib/api/chat-route.ts.
import { createChatRoute } from "@/lib/api/chat-route";

export const POST = createChatRoute({ scope: "brand" });
