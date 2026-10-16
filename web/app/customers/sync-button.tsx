"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useBackground } from "@/components/background-status";
import { syncCustomersAction } from "@/lib/sync-actions";

export function SyncButton() {
  const { run, starting, start } = useBackground();
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(true);
  const running = run?.kind === "sync" && run.status === "running";

  return (
    <span className="flex items-center gap-2">
      {msg && !running && (
        <span className={`text-xs ${ok ? "text-muted-foreground" : "text-destructive"}`}>
          {msg}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={starting || running}
        onClick={async () => {
          const r = await start(syncCustomersAction);
          setOk(r.ok);
          setMsg(r.ok ? null : r.message);
        }}
      >
        {running ? "Sincronizando…" : "Sincronizar"}
      </Button>
    </span>
  );
}
