"use client";

import { EntityChat } from "@/lib/entity-chat";

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
  return (
    <EntityChat
      url={`/api/companies/${companyId}/chat`}
      suggestions={SUGGESTED}
      emptyTitle="Pregunta por esta empresa"
      emptySubtitle="Leo su ficha, contactos, pedidos y campañas para responder."
      avatarLetter={companyName}
      placeholder="Pregunta por esta empresa…"
      inputAriaLabel="Pregunta por esta empresa"
    />
  );
}
