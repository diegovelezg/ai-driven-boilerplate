"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { useBackground } from "@/components/background-status";
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
  const { activeRuns, starting, start, isBusy } = useBackground();
  const [msg, setMsg] = useState<string | null>(null);

  if (isB2B) {
    return (
      <Button render={<Link href="#hoy-tabla" />} nativeButton={false} size="sm">
        Revisar de a uno
      </Button>
    );
  }
  const running = activeRuns.some((r) => r.kind === "copywriter");
  const busy = starting || running || isBusy("copywriter");
  const blocker = !running && isBusy("copywriter") ? activeRuns[0]?.label ?? null : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <AppTooltip tip={blocker ? `En curso: ${blocker}…` : undefined}>
        <span className="inline-flex">
          <Button
            size="sm"
            disabled={busy || actuarCount === 0}
            onClick={async () => {
              const r = await start(startCopywriterAction);
              setMsg(r.message);
            }}
          >
            {running ? "Redactando…" : busy ? "En proceso…" : `Redactar los ${actuarCount}`}
          </Button>
        </span>
      </AppTooltip>
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
