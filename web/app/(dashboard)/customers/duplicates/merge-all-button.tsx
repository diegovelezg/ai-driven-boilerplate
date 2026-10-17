"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Combine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { mergeAllDuplicatesAction } from "@/lib/merge-actions";

export function MergeAllBar({ totalGroups }: { totalGroups: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (totalGroups === 0 && !result) return null;

  const onClick = () => {
    setResult(null);
    startTransition(async () => {
      const r = await mergeAllDuplicatesAction();
      setResult({ ok: r.ok, message: r.message });
      if (r.merged > 0) router.refresh();
    });
  };

  const status = pending
    ? `Combinando ${totalGroups} caso${totalGroups === 1 ? "" : "s"}…`
    : (result?.message ?? `${totalGroups} caso${totalGroups === 1 ? "" : "s"} pendientes de combinar.`);

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <p
          aria-live="polite"
          className={`text-[13px] ${result && !result.ok ? "text-destructive" : "text-muted-foreground"}`}
        >
          {status}
        </p>
        <Button variant="default" size="sm" disabled={pending} onClick={onClick}>
          <Combine aria-hidden />
          {pending ? "Combinando…" : `Combinar todos (${totalGroups})`}
        </Button>
      </CardContent>
    </Card>
  );
}
