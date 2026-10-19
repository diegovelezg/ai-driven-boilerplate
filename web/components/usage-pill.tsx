"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { formatNumber } from "@/lib/format";

/** Compacta 1200 -> "1.2K", 2300000 -> "2.3M". */
function compact(n: number): string {
  const short = (v: number, suffix: string) => {
    const s = v.toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}${suffix}`;
  };
  if (n >= 1_000_000) return short(n / 1_000_000, "M");
  if (n >= 1_000) return short(n / 1_000, "K");
  return formatNumber(n);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pill sutil de consumo LLM del tenant activo (issue #15).
 * A la izquierda del MarketSelector: total de hoy + total histórico en texto,
 * detalle de llamadas en tooltip. Solo informativo, sin link.
 * Silencioso si no hay store, no hay datos o la API falla.
 */
export function UsagePill({ stores }: { stores: Array<{ id: string }> }) {
  const sp = useSearchParams();
  const param = sp.get("store");
  const activeId = stores.some((s) => s.id === param) ? (param as string) : (stores[0]?.id ?? null);
  const [todayTokens, setTodayTokens] = useState<number | null>(null);
  const [allTokens, setAllTokens] = useState<number | null>(null);
  const [todayCalls, setTodayCalls] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    const ctrl = new AbortController();
    const load = () => {
      const day = fetch(`/api/usage?store=${encodeURIComponent(activeId)}&from=${today()}`, {
        signal: ctrl.signal,
      }).then((r) => (r.ok ? r.json() : null));
      const all = fetch(`/api/usage?store=${encodeURIComponent(activeId)}`, {
        signal: ctrl.signal,
      }).then((r) => (r.ok ? r.json() : null));
      Promise.allSettled([day, all])
        .then(([d, a]) => {
          if (!alive) return;
          setLoaded(true);
          if (d.status === "fulfilled" && d.value && typeof d.value.total_tokens === "number") {
            setTodayTokens(d.value.total_tokens as number);
            setTodayCalls(typeof d.value.calls === "number" ? d.value.calls : 0);
          }
          if (a.status === "fulfilled" && a.value && typeof a.value.total_tokens === "number") {
            setAllTokens(a.value.total_tokens as number);
          }
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
  // Siempre visible para probar: mientras carga "● … hoy · … total", sin datos "● 0 hoy · 0 total".
  const day = todayTokens ?? (loaded ? 0 : null);
  const all = allTokens ?? (loaded ? 0 : null);
  const label = `● ${day === null ? "…" : compact(day)} hoy · ${all === null ? "…" : compact(all)} total`;
  const title =
    day !== null && all !== null
      ? `${compact(day)} tokens hoy · ${compact(all)} tokens en total · ${formatNumber(todayCalls ?? 0)} llamadas hoy`
      : null;
  return (
    <AppTooltip tip={title ?? "Sin llamadas LLM registradas"}>
      <span
        role="status"
        aria-label={title ?? "Uso de tokens: hoy e histórico"}
        className="hidden cursor-default items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground md:inline-flex"
      >
        <span className="size-1.5 rounded-full bg-emerald-500/70" aria-hidden />
        {label}
      </span>
    </AppTooltip>
  );
}
