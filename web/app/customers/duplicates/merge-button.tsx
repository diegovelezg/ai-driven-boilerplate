"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Combine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { mergeCustomersAction } from "@/lib/merge-actions";

export function MergeButton({ dbIds }: { dbIds: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    startTransition(async () => {
      const r = await mergeCustomersAction(dbIds);
      if (r.ok) router.refresh();
      else setError(r.message);
    });
  };

  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button variant="default" size="sm" disabled={pending} onClick={onClick}>
        <Combine aria-hidden />
        {pending ? "Combinando…" : "Combinar"}
      </Button>
    </span>
  );
}
