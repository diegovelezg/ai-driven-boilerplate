"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Revalida la página en fondo: re-pide el RSC al servidor y actualiza
 * héroe, embudo y tablas sin recargar ni perder estado cliente
 * (modales/selección se conservan: solo cambian los props del servidor).
 * Solo dispara con la pestaña visible; si un tick sigue en curso, el
 * siguiente se salta para no solapar renders.
 */
export function AutoRefresh({
  ms = 60_000,
  enabled = true,
}: {
  ms?: number;
  enabled?: boolean;
}) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || ms <= 0) return;
    const tick = () => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      inFlight.current = true;
      try {
        router.refresh();
      } finally {
        // El render es async y no avisa; se libera en el próximo tick
        // para no encadenar refreshes mientras React hidrata.
        setTimeout(() => {
          inFlight.current = false;
        }, 2000);
      }
    };
    timer.current = setInterval(tick, ms);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer.current) clearInterval(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, ms, enabled]);

  return null;
}
