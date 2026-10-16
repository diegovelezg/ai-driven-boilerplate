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
import { Check, RefreshCw, TriangleAlert, Wand2, X, type LucideIcon } from "lucide-react";
import { getBackgroundStatusAction } from "@/lib/background-actions";
import type { BackgroundRun } from "@/lib/background";

export interface BackgroundTaskResult {
  ok: boolean;
  message: string;
  run: BackgroundRun | null;
}

interface BackgroundCtxValue {
  run: BackgroundRun | null;
  starting: boolean;
  start: (action: () => Promise<BackgroundTaskResult>) => Promise<BackgroundTaskResult>;
}

const BackgroundCtx = createContext<BackgroundCtxValue | null>(null);

export function useBackground(): BackgroundCtxValue {
  const ctx = useContext(BackgroundCtx);
  if (!ctx) throw new Error("useBackground debe usarse dentro de <BackgroundStatus>");
  return ctx;
}

const ICONS: Record<string, LucideIcon> = {
  enrichment: Wand2,
  sync: RefreshCw,
};

const DISMISS_KEY = "background:dismissedRun";
const STALE_MS = 20 * 60 * 1000;
const AUTO_HIDE_MS = 5000;

/**
 * Cinta global de procesos en segundo plano (SSOT). Muestra el estado de la
 * última corrida y se cierra con la X cuando terminó. Un mismo componente sirve
 * para cualquier trabajo (enriquecimiento, sincronización, ...): sólo cambia el
 * `kind` de la corrida a la que responde.
 */
export function BackgroundStatus({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [run, setRun] = useState<BackgroundRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [dismissedId, setDismissedId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.localStorage.getItem(DISMISS_KEY),
  );
  // Tick para medir antigüedad sin leer el reloj durante el render.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    getBackgroundStatusAction().then(setRun);
  }, []);

  const running = run?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setNow(Date.now());
      getBackgroundStatusAction().then(setRun);
    }, 2000);
    return () => clearInterval(t);
  }, [running]);

  const start = useCallback(
    async (action: () => Promise<BackgroundTaskResult>) => {
      setStarting(true);
      try {
        const r = await action();
        if (r.run) setRun(r.run);
        router.refresh();
        return r;
      } finally {
        setStarting(false);
      }
    },
    [router],
  );

  const dismiss = useCallback(() => {
    if (!run) return;
    setDismissedId(run.id);
    window.localStorage.setItem(DISMISS_KEY, run.id);
  }, [run]);

  // Corrida "colgada" (p.ej. el server se reinició a mitad): se trata como terminada.
  const stale = running && !!run && now !== null && now - Date.parse(run.startedAt) > STALE_MS;
  const finished = !!run && (!running || stale);
  const succeeded = !!run && !running && !stale && run.status === "done";

  // Terminó con éxito: se oculta sola a los pocos segundos (no persiste si ya cumplió).
  useEffect(() => {
    if (!succeeded) return;
    const t = setTimeout(dismiss, AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [succeeded, dismiss]);

  const total = run?.total ?? 0;
  const processed = run?.processed ?? 0;
  const failed = run?.failed ?? 0;
  const done = processed + failed;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const visible = !!run && run.id !== dismissedId;
  const Icon = (run && ICONS[run.kind]) || Wand2;
  const label = run?.label ?? "";

  return (
    <BackgroundCtx.Provider value={{ run, starting, start }}>
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
                <Icon className="size-3.5 animate-pulse text-primary" aria-hidden />
                {label}… {done}/{total}
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
                  {label} listo{run?.summary ? ` · ${run.summary}` : ""}
                </>
              ) : (
                <>
                  <TriangleAlert className="size-3.5" aria-hidden />
                  {label} {stale ? "interrumpido" : "con errores"}
                  {run?.error ? ` · ${run.error}` : run?.summary ? ` · ${run.summary}` : ""}
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
    </BackgroundCtx.Provider>
  );
}
