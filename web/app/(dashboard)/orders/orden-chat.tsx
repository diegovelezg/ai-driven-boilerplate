"use client";

import { useCallback } from "react";
import { ChatShell } from "@/components/chat/chat-shell";
import { useStreamChat } from "@/components/chat/use-stream-chat";
import type { ChatMessage } from "@/components/chat/types";

const SUGGESTED = [
  "Resúmeme esta orden",
  "¿En qué etapa está y qué falta para avanzar?",
  "¿Cómo va la cobranza?",
  "¿Falta material o certificación?",
];

export function OrdenChat({
  orderId,
  orderLabel,
}: {
  orderId: string;
  orderLabel: string;
}) {
  const buildBody = useCallback((messages: ChatMessage[]) => ({ messages }), []);
  const { messages, input, setInput, pending, error, status, ask } = useStreamChat({
    url: `/api/orders/${orderId}/chat`,
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
      emptyTitle="Pregunta por esta orden"
      emptySubtitle="Leo su etapa operativa, cobranza y documentos para responder."
      emptyAvatar={
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold tracking-wide text-primary"
        >
          {(orderLabel.trim()[0] ?? "—").toUpperCase()}
        </div>
      }
      placeholder="Pregunta por esta orden…"
      inputAriaLabel="Pregunta por esta orden"
    />
  );
}
