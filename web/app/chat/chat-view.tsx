"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AgentFoco } from "@/app/api/chat/route";
import { ChatPanel, focoLabel } from "./chat-panel";

export function ChatView({
  storeId,
  storeName,
  initialFoco,
}: {
  storeId: string;
  storeName: string;
  initialFoco: AgentFoco;
}) {
  const router = useRouter();
  const [foco, setFoco] = useState<AgentFoco>(initialFoco);

  const switchFoco = (f: AgentFoco) => {
    setFoco(f);
    router.replace(`/chat?store=${storeId}&foco=${f}`);
  };

  return (
    <div className="flex w-full flex-col gap-4 p-6">
      <header className="flex flex-col gap-0.5">
        <h1 className="text-lg font-semibold tracking-tight">Pregúntale a tu equipo</h1>
        <span className="text-xs text-muted-foreground">
          Hablando de: {storeName} · {focoLabel(foco)}
        </span>
      </header>

      <ChatPanel storeId={storeId} foco={foco} onFocoChange={switchFoco} />

      <p className="text-xs text-muted-foreground">
        Mismo cerebro en todas partes: en la ficha hablas del cliente, aquí de {storeName}.{" "}
        <Link href="/" className="underline">Volver al overview</Link>
      </p>
    </div>
  );
}
