"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Combine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { mergeCustomersAction } from "@/lib/merge-actions";

export function MergeButton({ dbIds }: { dbIds: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onClick = () => {
    startTransition(async () => {
      try {
        const r = await mergeCustomersAction(dbIds);
        toast.add({
          title: r.ok ? "Casos combinados" : "No se pudo combinar",
          description: r.message,
          type: r.ok ? "success" : "error",
        });
        if (r.ok) router.refresh();
      } catch (e) {
        toast.add({
          title: "No se pudo combinar",
          description: e instanceof Error ? e.message : "Error inesperado.",
          type: "error",
        });
      }
    });
  };

  return (
    <span className="flex items-center gap-2">
      <Button variant="default" size="sm" disabled={pending} onClick={onClick}>
        <Combine aria-hidden />
        {pending ? "Combinando…" : "Combinar"}
      </Button>
    </span>
  );
}
