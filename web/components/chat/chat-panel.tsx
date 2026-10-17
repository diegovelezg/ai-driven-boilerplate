"use client";

import { useCallback } from "react";
import { ChatShell } from "@/components/chat/chat-shell";
import type { ChatArtifact } from "@/components/chat/types";
import { useStreamChat } from "@/components/chat/use-stream-chat";
import type { ChatMessage } from "@/components/chat/types";

/** Sugerencias del chat único: el orquestador rutea al especialista. */
const SUGGESTIONS = [
  "¿Quién está en riesgo esta semana y por qué?",
  "¿Cuánto recuperamos este mes?",
  "Muéstrame los borradores pendientes",
  "¿Qué hago primero hoy?",
];

/** Panel de chat store-scoped: lo usa el dock del dashboard.
 *  Chat único sin selector: el orquestador decide qué especialista responde
 *  (el badge `via` de cada burbuja lo indica). El dato estructurado siempre
 *  se eleva vía `onArtifact`: el host decide (navegar al Review filtrado).
 *  Este panel nunca pinta datos. */
export function ChatPanel({
  storeId,
  marketId = null,
  onArtifact,
}: {
  storeId: string;
  /** Filtro global por mercado (?market= del header). */
  marketId?: string | null;
  onArtifact: (artifact: ChatArtifact | null) => void;
}) {
  const buildBody = useCallback(
    (messages: ChatMessage[]) => ({ storeId, messages, marketId }),
    [storeId, marketId],
  );
  const { messages, input, setInput, pending, error, ask } = useStreamChat({
    url: "/api/chat",
    buildBody,
    onArtifact,
  });

  return (
    <ChatShell
      messages={messages}
      input={input}
      onInputChange={setInput}
      onAsk={(t) => void ask(t)}
      pending={pending}
      error={error}
      suggestions={SUGGESTIONS}
      emptyTitle="Pregúntale a tu equipo"
      emptySubtitle="Vigilan, proponen y miden por ti. Pregunta en lenguaje normal y el orquestador lanza al especialista."
      placeholder="Pregunta a tu equipo…"
    />
  );
}
