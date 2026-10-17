"use client";

import { ListChecks, PenLine, Radar, Send, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBackground } from "@/components/background-status";
import { startScoutAction } from "@/lib/scout-actions";
import {
  startAnalystAction,
  startCopywriterAction,
  startDispatcherAction,
  startStrategistAction,
} from "@/lib/retention-actions";

/** Controles del pipeline de retención: cada worker corre en background con su `kind`. */
export function RetentionControls() {
  const { run, starting, start } = useBackground();
  const running = run?.status === "running";
  const disabled = starting || running;

  const items = [
    { label: "Scout", icon: Radar, action: startScoutAction, title: "Detectar señales de churn" },
    { label: "Estratega", icon: ListChecks, action: startStrategistAction, title: "Priorizar señales abiertas" },
    { label: "Copywriter", icon: PenLine, action: startCopywriterAction, title: "Redactar borradores (LLM)" },
    { label: "Dispatcher", icon: Send, action: startDispatcherAction, title: "Enviar aprobadas (stub: sin proveedor)" },
    { label: "Analyst", icon: TrendingUp, action: startAnalystAction, title: "Medir conversiones post-envío" },
  ];

  return (
    <span className="flex flex-wrap items-center gap-2">
      {items.map((it) => (
        <Button
          key={it.label}
          size="sm"
          variant="outline"
          disabled={disabled}
          title={it.title}
          onClick={() => start(it.action)}
        >
          <it.icon className="text-primary" aria-hidden />
          {running && run?.label === it.label ? "En curso…" : it.label}
        </Button>
      ))}
    </span>
  );
}
