"use client";

import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEnrichment } from "@/components/enrichment-status";

export function EnrichmentControls({ pending }: { pending: number }) {
  const { run, starting, start } = useEnrichment();
  const running = run?.status === "running";
  const total = run?.total ?? 0;
  const done = (run?.processed ?? 0) + (run?.failed ?? 0);

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={starting || running || pending === 0}
      title={pending === 0 ? "No hay dominios de negocio pendientes" : "Enriquecer dominios con IA"}
      className="border-transparent bg-accent text-accent-foreground hover:bg-accent/70"
      onClick={start}
    >
      <Wand2 className="text-primary" aria-hidden />
      {running ? `${done}/${total}` : pending > 0 ? `Enriquecer (${pending})` : "Enriquecer"}
    </Button>
  );
}
