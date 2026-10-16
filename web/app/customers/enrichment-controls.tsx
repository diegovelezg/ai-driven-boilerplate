"use client";

import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBackground } from "@/components/background-status";
import { startEnrichmentAction } from "@/lib/enrich-actions";

export function EnrichmentControls({ pending }: { pending: number }) {
  const { run, starting, start } = useBackground();
  const running = run?.kind === "enrichment" && run.status === "running";
  const total = running ? run.total : 0;
  const done = running ? run.processed + run.failed : 0;

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={starting || running || pending === 0}
      title={pending === 0 ? "No hay dominios de negocio pendientes" : "Enriquecer dominios con IA"}
      className="border-transparent bg-accent text-accent-foreground hover:bg-accent/70"
      onClick={() => start(startEnrichmentAction)}
    >
      <Wand2 className="text-primary" aria-hidden />
      {running ? `${done}/${total}` : pending > 0 ? `Enriquecer (${pending})` : "Enriquecer"}
    </Button>
  );
}
