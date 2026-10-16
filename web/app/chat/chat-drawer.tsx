"use client";

import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import type { AgentFoco } from "@/app/api/chat/route";
import { ChatPanel, focoLabel } from "./chat-panel";

/** Drawer de chat: se abre sobre la vista actual sin perder contexto. */
export function ChatDrawer({
  storeId,
  storeName,
  initialFoco,
  open,
  onClose,
}: {
  storeId: string;
  storeName: string;
  initialFoco: AgentFoco;
  open: boolean;
  onClose: () => void;
}) {
  const [foco, setFoco] = useState<AgentFoco>(initialFoco);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex flex-col gap-0 p-0 data-[side=right]:sm:max-w-[min(800px,94vw)]">
        <div className="border-b px-5 py-4">
          <SheetTitle>Pregúntale a tu equipo</SheetTitle>
          <SheetDescription>
            Hablando de: {storeName} · {focoLabel(foco)}
          </SheetDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <ChatPanel storeId={storeId} foco={foco} onFocoChange={setFoco} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
