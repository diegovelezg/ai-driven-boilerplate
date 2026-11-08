"use client";

import { EntityChat } from "@/lib/entity-chat";

const SUGGESTED = [
  "Resúmeme esta empresa",
  "¿Tiene órdenes? ¿En qué estado?",
  "¿Quién es el contacto principal?",
  "¿Es anunciante, agencia o proveedor?",
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
      emptySubtitle="Leo su ficha, contactos, órdenes y campañas para responder."
      avatarLetter={companyName}
      placeholder="Pregunta por esta empresa…"
      inputAriaLabel="Pregunta por esta empresa"
    />
  );
}
