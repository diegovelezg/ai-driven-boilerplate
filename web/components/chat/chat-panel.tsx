"use client";

import { useCallback, useMemo, useState } from "react";
import { ChatShell } from "@/components/chat/chat-shell";
import type { ChatArtifact } from "@/components/chat/types";
import { useStreamChat } from "@/components/chat/use-stream-chat";
import type { ChatMessage } from "@/components/chat/types";

/** Pool de presets alineados al motor: decisiones (actuar/vigilar/no-tocar),
 *  ventanas de recompra, recupero medido, borradores, leads y resumen.
 *  Cada preset mapea a una tool real. Cada apertura muestra 3 al azar. */
export const SUGGESTION_POOL = [
  "¿A quién debo actuar hoy y por qué?",
  "¿Cuánto recuperamos este mes?",
  "Muéstrame los borradores pendientes",
  "¿Qué hago primero hoy?",
  "Dame el resumen de la tienda",
  "¿Qué clientes valiosos piden actuar hoy?",
  "Filtra customers en vigilancia",
  "¿Qué leads nuevos encontró el prospector?",
  "¿Quién entra en ventana esta semana?",
  "Muéstrame borradores de WhatsApp pendientes",
  "¿Cuál es la facturación bruta por moneda?",
  "¿Cuántos compradores vs customers tenemos?",
  "¿Cuánto recupero atribuido llevamos en 30 días?",
  "¿Quiénes están en primera recompra sin volver?",
  "¿Qué borradores puedo aprobar ya?",
  "¿A quién no tocamos hoy y por qué?",
  "¿Cuántos volverán solos sin que hagamos nada?",
];

/** 3 al azar sin repetir (Fisher-Yates parcial). */
export function pickRandomSuggestions(pool: string[], n = 3): string[] {
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(n, arr.length));
}

/** Panel de chat store-scoped: lo usa el dock del dashboard.
 *  Chat único sin selector: el orquestador decide qué especialista responde.
 *  El dato estructurado siempre se eleva vía `onArtifact`: el host decide
 *  (navegar al Review filtrado). Este panel nunca pinta datos. */
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
      suggestions={suggestions}
      onShuffleSuggestions={() => setNonce((n) => n + 1)}
      emptyTitle="Pregunta a tu equipo de agentes"
      emptySubtitle="Scout vigila, Estratega prioriza, Redactor propone y Analista mide. Pregunta en lenguaje normal — el orquestador lanza al especialista."
      placeholder="Pregunta a tu equipo…"
    />
  );
}
