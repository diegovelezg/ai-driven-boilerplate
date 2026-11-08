"use client";

import { EntityChat } from "@/lib/entity-chat";

const SUGGESTED = [
  "Resúmeme esta orden",
  "¿En qué etapa está y qué falta para avanzar?",
  "¿Cómo va la cobranza?",
  "¿Quién anuncia y quién paga esta orden?",
];

export function OrdenChat({
  orderId,
  orderLabel,
}: {
  orderId: string;
  orderLabel: string;
}) {
  return (
    <EntityChat
      url={`/api/orders/${orderId}/chat`}
      suggestions={SUGGESTED}
      emptyTitle="Pregunta por esta orden"
      emptySubtitle="Leo su etapa operativa, cobranza y documentos para responder."
      avatarLetter={orderLabel}
      placeholder="Pregunta por esta orden…"
      inputAriaLabel="Pregunta por esta orden"
    />
  );
}
