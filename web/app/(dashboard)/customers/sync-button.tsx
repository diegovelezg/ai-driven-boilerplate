"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { useBackground } from "@/components/background-status";
import { syncCustomersAction } from "@/lib/sync-actions";

export function SyncButton() {
  const { activeRuns, starting, start, isBusy } = useBackground();
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(true);
  const run = activeRuns.find((r) => r.kind === "sync") ?? null;
  const running = run !== null;
  const blocked = !running && isBusy("sync");
  const blocker = blocked
    ? activeRuns.find((r) => r.kind !== "sync")?.label ?? null
    : null;

  return (
    <span className="flex items-center gap-2">
      {msg && !running && (
        <span className={`text-xs ${ok ? "text-muted-foreground" : "text-destructive"}`}>
          {msg}
        </span>
      )}
      <AppTooltip tip={blocked && blocker ? `En curso: ${blocker}…` : undefined}>
        <span className="inline-flex">
          <Button
            size="sm"
            disabled={starting || running || blocked}
            onClick={async () => {
              const r = await start(syncCustomersAction);
              setOk(r.ok);
              setMsg(r.ok ? null : r.message);
            }}
          >
            <RefreshCw className={running || starting ? "animate-spin" : ""} aria-hidden />
            {running ? "Sincronizando…" : blocked ? "En proceso…" : "Sincronizar"}
          </Button>
        </span>
      </AppTooltip>
    </span>
  );
}
