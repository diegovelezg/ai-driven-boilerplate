"use client";

import { EntityChat } from "@/lib/entity-chat";

const SUGGESTED = [
  "Resúmeme esta pantalla",
  "¿Está libre los próximos 14 días?",
  "¿Qué precio, impacto y CPM tiene?",
  "¿En qué órdenes está pautada?",
];

export function PantallaChat({
  screenId,
  screenLabel,
}: {
  screenId: string;
  screenLabel: string;
}) {
  return (
    <EntityChat
      url={`/api/screens/${screenId}/chat`}
      suggestions={SUGGESTED}
      emptyTitle="Pregunta por esta pantalla"
      emptySubtitle="Leo su ficha, disponibilidad, precio e impacto para responder."
      avatarLetter={screenLabel}
      placeholder="Pregunta por esta pantalla…"
      inputAriaLabel="Pregunta por esta pantalla"
    />
  );
}
