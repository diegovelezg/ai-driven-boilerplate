"use client";

import { useCallback, useMemo, useState } from "react";
import { ChatShell } from "@/components/chat/chat-shell";
import type { ChatArtifact } from "@/components/chat/types";
import { useStreamChat } from "@/components/chat/use-stream-chat";
import type { ChatMessage } from "@/components/chat/types";

/** Pool de presets Fase 2 (DOOH, sin motor de retención): resumen de tienda,
 *  órdenes, inventario y empresas. Cada apertura muestra 3 al azar.
 *  (Histórico: los presets del loop scout/copywriter/prospector se retiraron
 *  con el motor extirpado en 20261122.) */
const SUGGESTION_POOL = [
  "Dame el resumen de la tienda",
  "¿Qué órdenes están en curso?",
  "Muéstrame el inventario disponible",
  "¿Qué empresas son anunciantes activos?",
  "¿Cuál es la facturación bruta?",
];

/** 3 al azar sin repetir (Fisher-Yates parcial). */
function pickRandomSuggestions(pool: string[], n = 3): string[] {
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(n, arr.length));
}

/** Panel de chat store-scoped: lo usa el dock del dashboard.
 *  Chat único con dooh_agent (5 tools read-only): empresas, órdenes,
 *  inventario y finanzas. El dato estructurado siempre se eleva vía `onArtifact`. */
export function ChatPanel({
  storeId,
  onArtifact,
}: {
  storeId: string;
  onArtifact: (artifact: ChatArtifact | null) => void;
}) {
  const buildBody = useCallback(
    (messages: ChatMessage[]) => ({ storeId, messages }),
    [storeId],
  );
  const { messages, input, setInput, pending, error, status, ask, retry } = useStreamChat({
    url: "/api/chat",
    buildBody,
    onArtifact,
  });
  // 3 presets al azar por apertura + botón "otras" para rotar.
  const [nonce, setNonce] = useState(0);
  const suggestions = useMemo(
    () => pickRandomSuggestions(SUGGESTION_POOL, 3),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeId, nonce],
  );

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
      onShuffleSuggestions={() => setNonce((n) => n + 1)}
      emptyTitle="Pregunta a tu asistente DOOH"
      emptySubtitle="Empresas, órdenes, inventario y finanzas. Pregunta en lenguaje normal — el asistente consulta tus datos."
      placeholder="Pregunta sobre tu negocio…"
    />
  );
}
