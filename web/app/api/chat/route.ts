// Chat único de la tienda: dooh_agent generalista con streaming SSE.
// SSOT del handler en lib/api/chat-route.ts.
import { createChatRoute } from "@/lib/api/chat-route";

export const POST = createChatRoute({ scope: "store" });
