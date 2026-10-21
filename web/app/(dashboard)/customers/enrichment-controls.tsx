"use client";

import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBackground } from "@/components/background-status";
import { startEnrichmentAction } from "@/lib/enrich-actions";
import { formatNumber } from "@/lib/format";
import { toast } from "@/components/ui/toast";

export function EnrichmentControls({ pending }: { pending: number }) {
  const { activeRuns, starting, start, isBusy } = useBackground();
  const run = activeRuns.find((r) => r.kind === "enrichment") ?? null;
  const running = run !== null;
  const blocked = !running && isBusy("enrichment");
  const busy = starting || running || blocked;

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || pending === 0}
      className="border-transparent bg-accent text-accent-foreground hover:bg-accent/70"
      onClick={async () => {
        const r = await start(startEnrichmentAction);
        if (!r.ok) {
          toast.add({ title: "No se pudo enriquecer", description: r.message, type: "error" });
        }
      }}
    >
      <Wand2 className="text-primary" aria-hidden />
      {running ? "Enriqueciendo…" : pending > 0 ? `Enriquecer (${formatNumber(pending)})` : "Enriquecer"}
    </Button>
  );
}
