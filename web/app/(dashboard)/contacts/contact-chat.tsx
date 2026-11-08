"use client";

import { useCallback } from "react";
import { ChatShell } from "@/components/chat/chat-shell";
import { useStreamChat } from "@/components/chat/use-stream-chat";
import type { ChatMessage } from "@/components/chat/types";

const SUGGESTED = [
  "Resúmeme este contacto",
  "¿Qué pedidos tiene su empresa?",
  "¿Es la persona que firma o aprueba?",
  "¿Qué le escribirías y por qué?",
];

export function ContactChat({
  contactId,
  contactLabel,
}: {
  contactId: string;
  contactLabel: string;
}) {
  const buildBody = useCallback((messages: ChatMessage[]) => ({ messages }), []);
  const { messages, input, setInput, pending, error, status, ask } = useStreamChat({
    url: `/api/contacts/${contactId}/chat`,
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
      emptyTitle="Pregunta por este contacto"
      emptySubtitle="Leo su ficha, su empresa y sus pedidos para responder."
      emptyAvatar={
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold tracking-wide text-primary"
        >
          {(contactLabel.trim()[0] ?? "—").toUpperCase()}
        </div>
      }
      placeholder="Pregunta por este contacto…"
      inputAriaLabel="Pregunta por este contacto"
    />
  );
}
