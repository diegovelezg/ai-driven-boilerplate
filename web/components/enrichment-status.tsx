"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Check, TriangleAlert, Wand2, X } from "lucide-react";
import {
  getEnrichmentStatusAction,
  startEnrichmentAction,
} from "@/lib/enrich-actions";
import type { EnrichRunStatus } from "@/lib/enrich";

interface EnrichmentCtxValue {
  run: EnrichRunStatus | null;
  starting: boolean;
  start: () => void;
}

const EnrichmentCtx = createContext<EnrichmentCtxValue | null>(null);

export function useEnrichment(): EnrichmentCtxValue {
  const ctx = useContext(EnrichmentCtx);
  if (!ctx) throw new Error("useEnrichment debe usarse dentro de <EnrichmentStatus>");
  return ctx;
}

const DISMISS_KEY = "enrichment:dismissedRun";
const STALE_MS = 20 * 60 * 1000;

/**
 * Provider global: mantiene el estado del enriquecimiento y muestra una cinta
 * persistente en todas las vistas. Se cierra con la X cuando terminó.
 */
export function EnrichmentStatus({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [run, setRun] = useState<EnrichRunStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [dismissedId, setDismissedId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.localStorage.getItem(DISMISS_KEY),
  );
  // Tick para medir antigüedad sin leer el reloj durante el render.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    getEnrichmentStatusAction().then(setRun);
  }, []);

  const running = run?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setNow(Date.now());
      getEnrichmentStatusAction().then(setRun);
    }, 2000);
    return () => clearInterval(t);
  }, [running]);

  const start = useCallback(() => {
    setStarting(true);
    startEnrichmentAction()
      .then((r) => {
        if (r.run) setRun(r.run);
        router.refresh();
      })
      .finally(() => setStarting(false));
  }, [router]);

  const dismiss = useCallback(() => {
    if (!run) return;
    setDismissedId(run.id);
    window.localStorage.setItem(DISMISS_KEY, run.id);
  }, [run]);

  // Corrida "colgada" (p.ej. el server se reinició a mitad): se trata como terminada.
  const stale = running && !!run && now !== null && now - Date.parse(run.startedAt) > STALE_MS;
  const finished = !!run && (!running || stale);

  const total = run?.total ?? 0;
  const processed = run?.processed ?? 0;
  const failed = run?.failed ?? 0;
  const done = processed + failed;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const visible = !!run && run.id !== dismissedId;

  return (
    <EnrichmentCtx.Provider value={{ run, starting, start }}>
      {children}
      {visible && (
        <div className="fixed inset-x-0 top-0 z-50">
          {!finished ? (
            <div className="relative h-9 overflow-hidden border-b border-border bg-accent text-accent-foreground">
              <div
                className="absolute inset-y-0 left-0 bg-primary/15 transition-[width] duration-700"
                style={{ width: `${pct}%` }}
              />
              <div className="pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-[enrich-sheen_1.6s_linear_infinite] bg-gradient-to-r from-transparent via-primary/25 to-transparent" />
              <div className="relative flex h-full items-center justify-center gap-2 text-xs font-medium tabular-nums">
                <Wand2 className="size-3.5 animate-pulse text-primary" aria-hidden />
                Enriqueciendo dominios… {done}/{total}
                {failed > 0 && <span className="text-destructive">· {failed} fallidos</span>}
              </div>
            </div>
          ) : (
            <div
              className={`relative flex h-9 items-center justify-center gap-2 border-b px-10 text-xs font-medium ${
                run?.status === "done" && !stale
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border-destructive/30 bg-destructive/10 text-destructive"
              }`}
            >
              {run?.status === "done" && !stale ? (
                <>
                  <Check className="size-3.5" aria-hidden />
                  Enriquecimiento listo · {processed} dominio{processed === 1 ? "" : "s"}
                  {failed > 0 && ` · ${failed} fallidos`}
                </>
              ) : (
                <>
                  <TriangleAlert className="size-3.5" aria-hidden />
                  Enriquecimiento {stale ? "interrumpido" : "con errores"} · {processed} ok ·{" "}
                  {failed} fallidos
                </>
              )}
              <button
                type="button"
                onClick={dismiss}
                aria-label="Cerrar"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 transition-colors hover:bg-foreground/10"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          )}
        </div>
      )}
    </EnrichmentCtx.Provider>
  );
}
