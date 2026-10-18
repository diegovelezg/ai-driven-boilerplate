"use client";

import { useCallback, useEffect, useRef } from "react";
import { ChatShell } from "@/components/chat/chat-shell";
import { useStreamChat } from "@/components/chat/use-stream-chat";
import type { ChatMessage } from "@/components/chat/types";

const SUGGESTED = [
  "¿Va a volver? ¿Cuándo y con qué probabilidad?",
  "¿Qué compró y cuándo fue lo último?",
  "¿Qué valor esperado tiene este customer?",
  "¿Qué oferta le harías para que vuelva?",
];

export function CustomerChat({
  dbId,
  customerName,
  initialPrompt,
  onInitialSent,
}: {
  dbId: string;
  customerName: string;
  /** Prompt sembrado desde Compras: se auto-envía una vez al montar. */
  initialPrompt?: string | null;
  onInitialSent?: () => void;
}) {
  const buildBody = useCallback((messages: ChatMessage[]) => ({ messages }), []);
  const { messages, input, setInput, pending, error, ask } = useStreamChat({
    url: `/api/customers/${dbId}/chat`,
    buildBody,
  });

  // Auto-envío del seed (una sola vez por valor, resiste re-renders/StrictMode).
  const sentSeed = useRef<string | null>(null);
  useEffect(() => {
    if (initialPrompt && sentSeed.current !== initialPrompt) {
      sentSeed.current = initialPrompt;
      void ask(initialPrompt);
      onInitialSent?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const initials = customerName
    .replace(/[^a-zA-Záéíóúñü@. ]/g, "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  return (
    <ChatShell
      messages={messages}
      input={input}
      onInputChange={setInput}
      onAsk={(t) => void ask(t)}
      pending={pending}
      error={error}
      suggestions={SUGGESTED}
      emptyTitle="Pregunta por este customer"
      emptySubtitle="Leo su ficha y su historial de compras para responder."
      emptyAvatar={
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold tracking-wide text-primary"
        >
          {initials || "—"}
        </div>
      }
      placeholder="Pregunta por este customer…"
      inputAriaLabel="Pregunta por este customer"
    />
  );
}
