"use client";

import { useCallback, useState } from "react";
import { postChatStream } from "./sse";
import { agentBadgeForTool, type ChatArtifact, type ChatMessage } from "./types";

/**
 * Estado + streaming para todo chat SSE (store y ficha).
 * SSOT del comportamiento: pending/error/input, `ask()` y `clear()`.
 * El transporte se inyecta (url + body) para no duplicar el fetch/SSE.
 * El último dato estructurado de una tool llega vía `onArtifact`
 * (el host decide dónde pintarlo: canvas o inline).
 */
export function useStreamChat(opts: {
  url: string;
  buildBody: (messages: ChatMessage[]) => unknown;
  onArtifact?: (artifact: ChatArtifact | null) => void;
}) {
  const { url, buildBody, onArtifact } = opts;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || pending) return;
      setError(null);
      const next: ChatMessage[] = [...messages, { role: "user", content: q }];
      setMessages(next);
      setInput("");
      setPending(true);
      try {
        await postChatStream({
          url,
          body: buildBody(next),
          setMessages,
          onArtifact: (a) => {
            // Badge orgánico: la tool usada firma la burbuja del turno.
            const via = agentBadgeForTool(a.tool);
            if (via) {
              setMessages((m) => {
                if (m.length === 0) return m;
                const copy = [...m];
                const last = copy[copy.length - 1];
                if (last.role !== "assistant") return m;
                copy[copy.length - 1] = { ...last, via };
                return copy;
              });
            }
            onArtifact?.(a);
          },
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Falló el chat.");
      } finally {
        setPending(false);
      }
    },
    [messages, pending, url, buildBody, onArtifact],
  );

  const clear = useCallback(() => {
    setMessages([]);
    setError(null);
    setInput("");
    onArtifact?.(null);
  }, [onArtifact]);

  return { messages, setMessages, input, setInput, pending, error, ask, clear };
}
