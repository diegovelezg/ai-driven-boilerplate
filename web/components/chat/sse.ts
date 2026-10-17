import type { ChatArtifact, ChatMessage } from "./types";

interface SseEvent {
  choices?: Array<{ delta?: { content?: string } }>;
  artifact?: ChatArtifact;
}

/** Extrae tokens OpenAI-style (`data: {choices[0].delta.content}`) y
 *  artefactos (`data: {artifact}`) de un stream SSE. */
export async function consumeSseStream(
  res: Response,
  onToken: (token: string) => void,
  onArtifact?: (artifact: ChatArtifact) => void,
): Promise<void> {
  if (!res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as SseEvent;
          const token = json.choices?.[0]?.delta?.content;
          if (token) onToken(token);
          if (json.artifact && onArtifact) {
            const rows = Array.isArray(json.artifact.data) ? json.artifact.data.length : 1;
            console.debug(
              `[chat] artifact ${json.artifact.tool} filas=${rows} query=${JSON.stringify(json.artifact.query ?? null)}`,
            );
            onArtifact(json.artifact);
          }
        } catch {
          // chunk parcial: se completa con el siguiente read
        }
      }
    }
  }
}

function errorMessage(res: Response, fallback: string): Promise<string> {
  return res
    .json()
    .catch(() => null)
    .then((j) => (j as { error?: string } | null)?.error ?? `${fallback} ${res.status}`);
}

/**
 * POST SSE genérico para todo chat (store + ficha): envía `body`,
 * crea el placeholder del asistente y va anexando tokens.
 * SSOT del comportamiento streaming: un solo lugar para ajustar
 * parsing, errores y limpieza del placeholder vacío.
 */
export async function postChatStream(opts: {
  url: string;
  body: unknown;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  onArtifact?: (artifact: ChatArtifact) => void;
}): Promise<void> {
  const { url, body, setMessages, onArtifact } = opts;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Falló la red.");
  }
  if (!res.ok || !res.body) throw new Error(await errorMessage(res, "HTTP"));

  setMessages((m) => [...m, { role: "assistant", content: "" }]);
  const appendToken = (token: string) =>
    setMessages((m) => {
      if (m.length === 0) return m;
      const copy = [...m];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { role: "assistant", content: last.content + token };
      return copy;
    });
  try {
    await consumeSseStream(res, appendToken, onArtifact);
  } catch (e) {
    // Sin tokens todavía: quitar el placeholder vacío para no dejar burbuja colgada.
    setMessages((m) =>
      m.length > 0 && m[m.length - 1].role === "assistant" && !m[m.length - 1].content
        ? m.slice(0, -1)
        : m,
    );
    throw e;
  }
}
