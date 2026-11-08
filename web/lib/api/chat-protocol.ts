// Protocolo puro del chat SSE (sin imports de servidor: testeable en node:test).
// SSOT del contrato que `components/chat/sse.ts` parsea:
//   data: {"choices":[{"delta":{"content":"…"}}]} → tokens
//   data: {"status":{"tool":"…"}}                 → "pensando"
//   data: {"artifact":{"tool":"…","data":…}}       → dato estructurado
export interface ChatMessageIn {
  role: "user" | "assistant";
  content: string;
}

const MAX_MESSAGES = 50;
const MAX_CONTENT = 8000;
const HISTORY_TURNS = 10;

export function sseEncode(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Valida el body del chat. Lanza Error con mensaje honesto (400). */
export function parseChatBody(body: unknown): { messages: ChatMessageIn[]; storeId: string | null } {
  if (!body || typeof body !== "object") throw new Error("Body inválido: se esperaba {messages}.");
  const b = body as Record<string, unknown>;
  const raw = b.messages;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) {
    throw new Error(`messages debe tener 1–${MAX_MESSAGES} turnos.`);
  }
  const messages: ChatMessageIn[] = raw.map((m) => {
    if (!m || typeof m !== "object") throw new Error("Mensaje inválido.");
    const r = m as Record<string, unknown>;
    if (r.role !== "user" && r.role !== "assistant") throw new Error("Mensaje inválido: role user|assistant.");
    const content = typeof r.content === "string" ? r.content : "";
    if (!content.trim() || content.length > MAX_CONTENT) {
      throw new Error(`Contenido inválido (1–${MAX_CONTENT} caracteres).`);
    }
    return { role: r.role, content };
  });
  const last = messages[messages.length - 1];
  if (last.role !== "user") throw new Error("El último turno debe ser del usuario.");
  const storeId = typeof b.storeId === "string" && b.storeId.trim() !== "" ? b.storeId.trim() : null;
  return { messages, storeId };
}

/** Prompt de un turno: pregunta + historial reciente acotado (stateless). */
export function buildChatPrompt(messages: ChatMessageIn[]): { text: string } {
  const last = messages[messages.length - 1];
  const history = messages.slice(0, -1).slice(-HISTORY_TURNS);
  const hist =
    history.length > 0
      ? `\n\nHistorial reciente (antiguo→nuevo):\n${history
          .map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.content.slice(0, 2000)}`)
          .join("\n")}`
      : "";
  return { text: `Pregunta actual del usuario:\n${last.content}${hist}` };
}
