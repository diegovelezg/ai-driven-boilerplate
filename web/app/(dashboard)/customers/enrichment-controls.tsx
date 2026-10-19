"use client";

import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { useBackground } from "@/components/background-status";
import { startEnrichmentAction } from "@/lib/enrich-actions";
import { formatNumber } from "@/lib/format";

export function EnrichmentControls({ pending }: { pending: number }) {
  const { activeRuns, starting, start, isBusy } = useBackground();
  const run = activeRuns.find((r) => r.kind === "enrichment") ?? null;
  const running = run !== null;
  const total = running ? run.total : 0;
  const done = running ? run.processed + run.failed : 0;
  const blocked = !running && isBusy("enrichment");
  const blocker = blocked ? activeRuns[0]?.label ?? null : null;

  return (
    <AppTooltip
      tip={
        pending === 0
          ? "No hay dominios de negocio pendientes"
          : blocked && blocker
            ? `En curso: ${blocker}…`
            : "Enriquecer dominios con IA"
      }
    >
      <span className="inline-flex">
        <Button
          size="sm"
          variant="outline"
          disabled={starting || running || blocked || pending === 0}
          className="border-transparent bg-accent text-accent-foreground hover:bg-accent/70"
          onClick={() => start(startEnrichmentAction)}
        >
          <Wand2 className="text-primary" aria-hidden />
          {running ? `${formatNumber(done)}/${formatNumber(total)}` : blocked ? "En proceso…" : pending > 0 ? `Enriquecer (${formatNumber(pending)})` : "Enriquecer"}
        </Button>
      </span>
    </AppTooltip>
  );
}
