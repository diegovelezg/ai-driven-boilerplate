"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useBackground } from "@/components/background-status";
import { startCopywriterAction } from "@/lib/retention-actions";
import { formatNumber } from "@/lib/format";
import { toast } from "@/components/ui/toast";

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
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={busy || redactableCount === 0}
        onClick={async () => {
          const r = await start(startCopywriterAction);
          if (!r.ok) {
            toast.add({ title: "No se pudo redactar", description: r.message, type: "error" });
          }
        }}
      >
        {running ? "Redactando…" : `Redactar los ${formatNumber(redactableCount)}`}
      </Button>
      <Button render={<Link href={reviewHref} />} nativeButton={false} variant="outline" size="sm">
        Ir a Review
      </Button>
    </span>
  );
}
