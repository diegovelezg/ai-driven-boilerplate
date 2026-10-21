"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Combine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { toast } from "@/components/ui/toast";
import { mergeAllDuplicatesAction } from "@/lib/merge-actions";
import { formatNumber } from "@/lib/format";

export function MergeAllBar({ totalGroups }: { totalGroups: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (totalGroups === 0) return null;

  const onClick = () => {
    startTransition(async () => {
      try {
        const r = await mergeAllDuplicatesAction();
        toast.add({
          title: r.ok ? "Casos combinados" : "No se pudo combinar",
          description: r.message,
          type: r.ok ? "success" : "error",
        });
        if (r.merged > 0) router.refresh();
      } catch (e) {
        toast.add({
          title: "No se pudo combinar",
          description: e instanceof Error ? e.message : "Error inesperado.",
          type: "error",
        });
      }
    });
  };

  const status = pending
    ? `Combinando ${formatNumber(totalGroups)} caso${totalGroups === 1 ? "" : "s"}…`
    : `${formatNumber(totalGroups)} caso${totalGroups === 1 ? "" : "s"} pendientes de combinar.`;

  return (
    <AppCard
      footer={
        <Button variant="default" size="sm" disabled={pending} onClick={onClick}>
          <Combine aria-hidden />
          {pending ? "Combinando…" : `Combinar todos (${formatNumber(totalGroups)})`}
        </Button>
      }
    >
      <p aria-live="polite" className="text-[13px] text-muted-foreground">
        {status}
      </p>
    </AppCard>
  );
}
