"use client";

import { useState, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import type { AgentFoco } from "@/app/api/chat/route";
import { ChatDrawer } from "./chat/chat-drawer";

/** Card clicable: abre el chat en drawer con el foco del grupo, sin salir de la página. */
export function AgentCard({
  storeId,
  storeName,
  foco,
  children,
}: {
  storeId: string;
  storeName: string;
  foco: AgentFoco;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Card
        role="button"
        tabIndex={0}
        title="Click para preguntar a tu equipo"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="cursor-pointer transition-colors hover:border-primary/40"
      >
        {children}
      </Card>
      {open && (
        <ChatDrawer
          storeId={storeId}
          storeName={storeName}
          initialFoco={foco}
          open={open}
          onClose={() => setOpen(false)}
        />
      )}
    </>
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
