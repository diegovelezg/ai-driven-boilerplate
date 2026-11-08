"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AppCard } from "@/components/app-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { dismissInsightAction } from "@/lib/insights-actions";
import type { WallInsight } from "@/lib/insights";

/** Muro de insights (issue #11): feed persistido, no toast efímero.
//  Un solo muro por tenant; lo personal es el filtro `Mis pendientes`. */
export function InsightsWall({ initial }: { initial: WallInsight[] }) {
  const [mineOnly, setMineOnly] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<string | null>(null);

  const visible = useMemo(() => {
    const live = initial.filter((i) => !i.dismissed && !hidden.has(i.id));
    const mineCount = live.filter((i) => i.mine).length;
    return { list: mineOnly ? live.filter((i) => i.mine) : live, mineCount, total: live.length };
  }, [initial, mineOnly, hidden]);

  async function dismiss(id: string) {
    setPending(id);
    try {
      const r = await dismissInsightAction(id);
      if (!r.ok) {
        toast.add({ title: "No se pudo descartar", description: r.message, type: "error" });
        return;
      }
      setHidden((prev) => new Set(prev).add(id));
    } finally {
      setPending(null);
    }
  }

  if (visible.total === 0) return null;

  return (
    <AppCard
      title={`Muro (${visible.total})`}
      description="Qué importa hoy y qué hacer. Sin novedad = silencio, no ruido."
      className="self-start"
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <Button
          size="sm"
          variant={mineOnly ? "default" : "secondary"}
          nativeButton
          onClick={() => setMineOnly((v) => !v)}
          title={mineOnly ? "Ver todo el muro" : "Filtrar solo mis pendientes"}
        >
          Mis pendientes ({visible.mineCount})
        </Button>
      </div>
      {visible.list.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          Sin pendientes para ti. Todo el muro sigue visible con el filtro apagado.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {visible.list.map((i) => (
            <li key={i.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="gap-1 font-normal">
                    {i.kind.replace(/_/g, " ")}
                  </Badge>
                  {i.mine && (
                    <Badge variant="secondary" className="gap-1 font-normal">
                      para mí
                    </Badge>
                  )}
                  <span className="text-sm font-medium">{i.title}</span>
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{i.body}</span>
                <span className="mt-1 flex flex-wrap gap-2">
                  {(i.links ?? []).slice(0, 2).map((l) => (
                    <Link key={l} href={l} className="text-xs underline underline-offset-2">
                      Abrir
                    </Link>
                  ))}
                </span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                nativeButton
                disabled={pending === i.id}
                title={pending === i.id ? "Descartando…" : "Descartar este aviso (solo para ti)"}
                onClick={() => void dismiss(i.id)}
              >
                {pending === i.id ? "…" : "Descartar"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </AppCard>
  );
}
