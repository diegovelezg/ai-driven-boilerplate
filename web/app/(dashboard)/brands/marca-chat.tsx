"use client";

import { EntityChat } from "@/lib/entity-chat";

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
  return (
    <EntityChat
      url={`/api/brands/${encoded}/chat`}
      suggestions={SUGGESTED}
      emptyTitle="Pregunta por esta marca"
      emptySubtitle="Leo sus pedidos, empresas, pantallas e inversión para responder."
      avatarLetter={brandName}
      placeholder="Pregunta por esta marca…"
      inputAriaLabel="Pregunta por esta marca"
    />
  );
}
