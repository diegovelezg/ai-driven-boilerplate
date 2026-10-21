"use client";

import { useCallback } from "react";
import { ChatShell } from "@/components/chat/chat-shell";
import { useStreamChat } from "@/components/chat/use-stream-chat";
import type { ChatMessage } from "@/components/chat/types";

const SUGGESTED = [
  "¿Quiénes compran más este ítem?",
  "¿Cuándo se vende más este ítem?",
  "¿Qué metadata traen sus compras?",
  "¿Qué harías para vender más de este ítem?",
];

export function ProductChat({
  productId,
  productTitle,
  market,
}: {
  productId: string;
  productTitle: string;
  market: string | null;
}) {
  const buildBody = useCallback((messages: ChatMessage[]) => ({ messages, marketId: market }), [market]);
  const { messages, input, setInput, pending, error, ask } = useStreamChat({
    url: `/api/products/${productId}/chat`,
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
      suggestions={SUGGESTED}
      emptyTitle="Pregunta por este ítem"
      emptySubtitle="Leo sus ventas y compradores para responder."
      emptyAvatar={
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold tracking-wide text-primary"
        >
          {(productTitle.trim()[0] ?? "—").toUpperCase()}
        </div>
      }
      placeholder="Pregunta por este ítem…"
      inputAriaLabel="Pregunta por este ítem"
    />
  );
}
