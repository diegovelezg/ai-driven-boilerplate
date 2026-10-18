"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { startCopywriterAction } from "@/lib/retention-actions";

/** CTAs del héroe de Hoy: lote solo en no-B2B; en B2B se revisa de a uno. */
export function HoyHeroActions({
  actuarCount,
  isB2B,
  reviewHref,
}: {
  actuarCount: number;
  isB2B: boolean;
  reviewHref: string;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (isB2B) {
    return (
      <Button render={<Link href="#hoy-tabla" />} nativeButton={false} size="sm">
        Revisar de a uno
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={pending || actuarCount === 0}
        onClick={() =>
          startTransition(async () => {
            const r = await startCopywriterAction();
            setMsg(r.message);
          })
        }
      >
        {pending ? "Redactando…" : `Redactar los ${actuarCount}`}
      </Button>
      {msg ? (
        <span className="text-xs text-muted-foreground">{msg}</span>
      ) : (
        <Button render={<Link href={reviewHref} />} nativeButton={false} variant="outline" size="sm">
          Ir a Review
        </Button>
      )}
    </span>
  );
}
