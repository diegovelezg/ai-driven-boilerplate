"use client";

import { useCallback, useState } from "react";
import { postChatStream } from "./sse";
import type { ChatArtifact, ChatMessage } from "./types";
import { createChatId } from "./types";

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
  /** Trabajo en curso del agente ("Buscando pantallas…"); null = genérico. */
  const [status, setStatus] = useState<string | null>(null);

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || pending) return;
      setError(null);
      setStatus(null);
      const next: ChatMessage[] = [...messages, { id: createChatId(), role: "user", content: q }];
      setMessages(next);
      setInput("");
      setPending(true);
      try {
        await postChatStream({
          url,
          body: buildBody(next),
          setMessages,
          onArtifact,
          onStatus: setStatus,
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
    setStatus(null);
    onArtifact?.(null);
  }, [onArtifact]);

  // Reintento: reenvía los mensajes actuales (ya terminan en el turno del
  // usuario) sin duplicar la burbuja. `ask()` no sirve: agregaría otro turno.
  const retry = useCallback(async () => {
    if (pending || messages.length === 0) return;
    setError(null);
    setStatus(null);
    setPending(true);
    try {
      await postChatStream({
        url,
        body: buildBody(messages),
        setMessages,
        onArtifact,
        onStatus: setStatus,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falló el chat.");
    } finally {
      setPending(false);
    }
  }, [messages, pending, url, buildBody, onArtifact]);

  return { messages, setMessages, input, setInput, pending, error, status, ask, clear, retry };
}
