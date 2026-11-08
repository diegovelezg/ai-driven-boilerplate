"use client";

// SSOT visual de chats de ficha (issue #8 P2): empresa, marca, contacto,
// orden y pantalla calcaban el mismo bloque useStreamChat + ChatShell (avatar inicial,
// sugerencias, títulos). Lo distinto va por props; este wrapper es el único
// que toca ChatShell/useStreamChat para fichas.
// profile-chat NO migra: usa server actions + tarjeta de propuesta propias.
import { useCallback } from "react";
import { ChatShell } from "@/components/chat/chat-shell";
import { useStreamChat } from "@/components/chat/use-stream-chat";
import type { ChatMessage } from "@/components/chat/types";

export interface EntityChatProps {
  /** URL del endpoint chat de la ficha (p. ej. /api/companies/:id/chat). */
  url: string;
  suggestions: string[];
  emptyTitle: string;
  emptySubtitle: string;
  /** Letra del avatar (inicial del nombre/etiqueta). */
  avatarLetter: string;
  placeholder: string;
  inputAriaLabel?: string;
}

export function EntityChat({
  url,
  suggestions,
  emptyTitle,
  emptySubtitle,
  avatarLetter,
  placeholder,
  inputAriaLabel,
}: EntityChatProps) {
  const buildBody = useCallback((messages: ChatMessage[]) => ({ messages }), []);
  const { messages, input, setInput, pending, error, status, ask, retry } = useStreamChat({
    url,
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
      onRetry={() => void retry()}
      status={status}
      suggestions={suggestions}
      emptyTitle={emptyTitle}
      emptySubtitle={emptySubtitle}
      emptyAvatar={
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold tracking-wide text-primary"
        >
          {(avatarLetter.trim()[0] ?? "—").toUpperCase()}
        </div>
      }
      placeholder={placeholder}
      inputAriaLabel={inputAriaLabel ?? placeholder}
    />
  );
}
