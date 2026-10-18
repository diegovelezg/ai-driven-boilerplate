"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/** Compacta 12345 -> "12.3k", 2000000 -> "2.0M". */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pill sutil de consumo LLM del tenant activo (issue #15).
 * A la izquierda del MarketSelector: solo total de hoy + llamadas en tooltip.
 * Silencioso si no hay store, no hay datos o la API falla.
 */
export function UsagePill({ stores }: { stores: Array<{ id: string }> }) {
  const sp = useSearchParams();
  const param = sp.get("store");
  const activeId = stores.some((s) => s.id === param) ? (param as string) : (stores[0]?.id ?? null);
  const [text, setText] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    const ctrl = new AbortController();
    const load = () => {
      fetch(`/api/usage?store=${encodeURIComponent(activeId)}&from=${today()}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!alive) return;
          setLoaded(true);
          if (!j || typeof j.total_tokens !== "number") return;
          const total = j.total_tokens as number;
          const calls = typeof j.calls === "number" ? j.calls : 0;
          setText(`● ${compact(total)} hoy`);
          setTitle(`${total.toLocaleString("es-PE")} tokens hoy · ${calls} llamadas`);
        })
        .catch(() => {
          if (alive) setLoaded(true);
        });
    };
    load();
    // El pill monta una vez; los chats ocurren despues: revalida cada 30s y al volver el foco.
    const t = setInterval(load, 30_000);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("focus", load);
      ctrl.abort();
    };
  }, [activeId]);

  if (!activeId) return null;
  // Siempre visible para probar: mientras carga "● … hoy", sin datos "● 0 hoy".
  const label = text ?? (loaded ? "● 0 hoy" : "● … hoy");
  return (
    <a
      href={`/settings?store=${encodeURIComponent(activeId)}`}
      title={title ?? "Sin llamadas LLM hoy"}
      aria-label={title ?? "Uso de tokens de hoy"}
      className="hidden items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground transition-colors hover:text-foreground md:inline-flex"
    >
      <span className="size-1.5 rounded-full bg-emerald-500/70" aria-hidden />
      {label}
    </a>
  );
}
