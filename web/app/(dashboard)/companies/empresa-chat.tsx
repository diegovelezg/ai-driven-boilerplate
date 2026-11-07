"use client";

import { useCallback } from "react";
import { ChatShell } from "@/components/chat/chat-shell";
import { useStreamChat } from "@/components/chat/use-stream-chat";
import type { ChatMessage } from "@/components/chat/types";

const SUGGESTED = [
  "Resúmeme esta empresa",
  "¿Tiene pedidos? ¿En qué estado?",
  "¿Quién es el contacto principal?",
  "¿Qué campañas tiene?",
];

export function EmpresaChat({
  companyId,
  companyName,
}: {
  companyId: string;
  companyName: string;
}) {
  const buildBody = useCallback((messages: ChatMessage[]) => ({ messages }), []);
  const { messages, input, setInput, pending, error, status, ask } = useStreamChat({
    url: `/api/companies/${companyId}/chat`,
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
      emptyTitle="Pregunta por esta empresa"
      emptySubtitle="Leo su ficha, contactos, pedidos y campañas para responder."
      emptyAvatar={
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold tracking-wide text-primary"
        >
          {(companyName.trim()[0] ?? "—").toUpperCase()}
        </div>
      }
      placeholder="Pregunta por esta empresa…"
      inputAriaLabel="Pregunta por esta empresa"
    />
  );
}
