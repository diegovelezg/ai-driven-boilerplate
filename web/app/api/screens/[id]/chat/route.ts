// Chat del drawer de pantalla: mismo agente generalista con foco en la pantalla.
// SSOT del handler en lib/api/chat-route.ts.
import { createChatRoute } from "@/lib/api/chat-route";

export const POST = createChatRoute({ scope: "screen" });
