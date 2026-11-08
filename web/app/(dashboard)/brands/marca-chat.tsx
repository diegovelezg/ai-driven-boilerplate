"use client";

import { useCallback } from "react";
import { ChatShell } from "@/components/chat/chat-shell";
import { useStreamChat } from "@/components/chat/use-stream-chat";
import type { ChatMessage } from "@/components/chat/types";

const SUGGESTED = [
  "Resúmeme esta marca",
  "¿En qué pedidos pauta? ¿En qué estado?",
  "¿Qué empresas anuncian esta marca?",
  "¿En qué pantallas tiene presencia?",
];

export function MarcaChat({
  brandName,
}: {
  brandName: string;
}) {
  const encoded = encodeURIComponent(brandName);
  const buildBody = useCallback((messages: ChatMessage[]) => ({ messages }), []);
  const { messages, input, setInput, pending, error, status, ask } = useStreamChat({
    url: `/api/brands/${encoded}/chat`,
    buildBody,
  });

  return (
    <ChatShell
      messages={messages}
      input={input}
      onInputChange={setInput}
      onAsk={(t) => void ask(t)}
      pending={pending}
      error={error}
      status={status}
      suggestions={SUGGESTED}
      emptyTitle="Pregunta por esta marca"
      emptySubtitle="Leo sus pedidos, empresas, pantallas e inversión para responder."
      emptyAvatar={
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold tracking-wide text-primary"
        >
          {(brandName.trim()[0] ?? "—").toUpperCase()}
        </div>
      }
      placeholder="Pregunta por esta marca…"
      inputAriaLabel="Pregunta por esta marca"
    />
  );
}
