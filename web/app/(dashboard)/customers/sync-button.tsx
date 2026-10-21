"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBackground } from "@/components/background-status";
import { syncCustomersAction } from "@/lib/sync-actions";
import { toast } from "@/components/ui/toast";

export function SyncButton() {
  const { activeRuns, starting, start, isBusy } = useBackground();
  const run = activeRuns.find((r) => r.kind === "sync") ?? null;
  const running = run !== null;
  const blocked = !running && isBusy("sync");
  const busy = starting || running || blocked;

  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={async () => {
        try {
          const r = await start(syncCustomersAction);
          // Con run la cinta ya avisa; sin run avisar aquí.
          if (!r.ok && !r.run) {
            toast.add({ title: "No se pudo sincronizar", description: r.message, type: "error" });
          }
        } catch (e) {
          toast.add({
            title: "No se pudo sincronizar",
            description: e instanceof Error ? e.message : "Error inesperado.",
            type: "error",
          });
        }
      }}
    >
      <RefreshCw className={busy ? "animate-spin" : undefined} aria-hidden />
      {running ? "Sincronizando…" : "Sincronizar"}
    </Button>
  );
}
