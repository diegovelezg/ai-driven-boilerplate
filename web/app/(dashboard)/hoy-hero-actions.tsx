"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { useBackground } from "@/components/background-status";
import { startCopywriterAction } from "@/lib/retention-actions";
import { formatNumber } from "@/lib/format";

/** CTAs del héroe de Hoy: lote solo en no-B2B; en B2B se revisa de a uno.
 *  El botón solo se ofrece si hay algo redactable: si todo lo accionable ya
 *  tiene borrador o está vetado, se muestra "Ir a Review" en vez de un
 *  "Redactar los N" que devolvería 0 y parece roto. */
export function HoyHeroActions({
  redactableCount,
  pendingCount = 0,
  isB2B,
  reviewHref,
}: {
  /** Filas de Hoy sin borrador y sin veto (las únicas que el bulk puede crear). */
  redactableCount: number;
  pendingCount?: number;
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
  // Nada redactable: no ofrecer un bulk que devolvería 0. El trabajo ya está
  // en Review (o vetado): el CTA honesto es ir ahí.
  if (redactableCount <= 0) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Button render={<Link href={reviewHref} />} nativeButton={false} size="sm">
          Ir a Review
        </Button>
        {pendingCount > 0 ? (
          <span className="text-xs text-muted-foreground">
            {pendingCount === 1 ? "Listo en Review, falta tu aprobación." : "Listos en Review, falta tu aprobación."}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            Nada fresco que redactar (vetado o ya cubierto).
          </span>
        )}
      </span>
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
            disabled={busy || redactableCount === 0}
            onClick={async () => {
              const r = await start(startCopywriterAction);
              setMsg(r.message);
            }}
          >
            {running ? "Redactando…" : busy ? "En proceso…" : `Redactar los ${formatNumber(redactableCount)}`}
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
