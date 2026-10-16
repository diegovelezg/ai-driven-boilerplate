"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { syncCustomersAction } from "@/lib/sync-actions";

export function SyncButton() {
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(true);

  return (
    <span className="flex items-center gap-2">
      {msg && (
        <span className={`text-xs ${ok ? "text-muted-foreground" : "text-destructive"}`}>
          {msg}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const r = await syncCustomersAction();
            setOk(r.ok);
            setMsg(r.message);
          })
        }
      >
        {isPending ? "Sincronizando…" : "Sincronizar"}
      </Button>
    </span>
  );
}
