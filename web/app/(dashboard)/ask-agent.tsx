"use client";

import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { useChatDock } from "@/components/chat/chat-dock";

/** Card clicable: abre el chat en dock a la izquierda con la tienda,
 *  sin salir de la página (la vista queda a la derecha). Sin selector de
 *  agente: el orquestador rutea solo. */
export function AgentCard({
  storeId,
  storeName,
  children,
}: {
  storeId: string;
  storeName: string;
  children: ReactNode;
}) {
  const { dock, openDock } = useChatDock();
  const active = dock?.storeId === storeId;

  return (
    <AppTooltip tip="Click para preguntar a tu equipo">
      <Card
        role="button"
        tabIndex={0}
        onClick={() => openDock({ storeId, storeName })}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDock({ storeId, storeName });
        }
      }}
      className={`cursor-pointer transition-colors hover:border-primary/40${active ? " border-primary/60 ring-1 ring-primary/30" : ""}`}
      >
        {children}
      </Card>
    </AppTooltip>
  );
}

/** Zona dentro de un AgentCard que NO abre el chat (CTAs como Revisar/Ajustes). */
export function ClickStop({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={className}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
    >
      {children}
    </span>
  );
}
