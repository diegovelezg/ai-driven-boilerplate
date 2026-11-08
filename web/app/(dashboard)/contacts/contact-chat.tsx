"use client";

import { EntityChat } from "@/lib/entity-chat";

const SUGGESTED = [
  "Resúmeme este contacto",
  "¿Qué órdenes tiene su empresa?",
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
  return (
    <EntityChat
      url={`/api/contacts/${contactId}/chat`}
      suggestions={SUGGESTED}
      emptyTitle="Pregunta por este contacto"
      emptySubtitle="Leo su ficha, su empresa y sus órdenes para responder."
      avatarLetter={contactLabel}
      placeholder="Pregunta por este contacto…"
      inputAriaLabel="Pregunta por este contacto"
    />
  );
}
