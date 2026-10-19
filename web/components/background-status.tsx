"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { getActiveRunsAction } from "@/lib/background-actions";
import type { BackgroundRun } from "@/lib/background";
import { errorCodeMessage, isCompatible } from "@/lib/operations";
import { isJudgeVetoMessage } from "@/lib/single-audit";
import { formatNumber } from "@/lib/format";
import { toast } from "@/components/ui/toast";

interface BackgroundTaskResult {
  ok: boolean;
  message: string;
  run: BackgroundRun | null;
}

interface BackgroundCtxValue {
  /** En curso + últimos terminados (los toasts los muestran abajo-derecha). */
  runs: BackgroundRun[];
  activeRuns: BackgroundRun[];
  starting: boolean;
  start: (action: () => Promise<BackgroundTaskResult>) => Promise<BackgroundTaskResult>;
  /** ¿Esta operación chocaría con algo en curso? (botones que se
   *  desactivan solos según incompatibilidad real). */
  isBusy: (kind: string, scopeId?: string | null) => boolean;
}

const BackgroundCtx = createContext<BackgroundCtxValue | null>(null);

export function useBackground(): BackgroundCtxValue {
  const ctx = useContext(BackgroundCtx);
  if (!ctx) throw new Error("useBackground debe usarse dentro de <BackgroundStatus>");
  return ctx;
}

/** `null` fuera del provider (hosts sin toasts, p.ej. canvas del chat):
 *  el llamador usa su vía local en vez de romper. */
export function useBackgroundOrNull(): BackgroundCtxValue | null {
  return useContext(BackgroundCtx);
}

const DISMISS_KEY = "background:dismissedRuns";
const LEGACY_DISMISS_KEY = "background:dismissedRun";
const STALE_MS = 20 * 60 * 1000;
const AUTO_HIDE_MS = 5000;
const ERROR_HIDE_MS = 15000;
const SUMMARY_MAX = 120;

function readDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    const legacy = window.localStorage.getItem(LEGACY_DISMISS_KEY);
    if (legacy) ids.push(legacy);
    return new Set(ids.filter((id) => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/** ¿La corrida es un veto del juez? (`error_code` nuevo, o el summary en
 *  DBs aún sin migrar.) El veto es omisión, no éxito ni fallo. */
function isVetoRun(run: BackgroundRun): boolean {
  return run.errorCode === "judge_veto" || (run.summary ? isJudgeVetoMessage(run.summary) : false);
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Provider global de procesos en segundo plano (SSOT, issue #16 Fase 2).
 * Mantiene polling, lock por compatibilidad y refresh; la presentación es
 * el Toast base shadcn (abajo-derecha, auto-height, stacking nativo).
 * Un mismo provider sirve para cualquier trabajo; solo cambia el
 * `kind`/`scope` de cada corrida.
 */
export function BackgroundStatus({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [runs, setRuns] = useState<BackgroundRun[]>([]);
  const [starting, setStarting] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  // Tick para medir antigüedad sin leer el reloj durante el render.
  const [now, setNow] = useState<number>(() => Date.now());
  // Snapshot para no re-renderizar ni refrescar la página si el poll no
  // trajo cambios (era: setRuns con array nuevo cada 2s + router.refresh()
  // en cada transición → parpadeo de página completa en corridas largas).
  const lastKeyRef = useRef<string | null>(null);
  const pollGenRef = useRef(0);
  const watchKeyRef = useRef<string | null>(null);
  const lastAutoRefreshRef = useRef<number>(0);
  const knownToastIdsRef = useRef<Set<string>>(new Set());
  const runsKey = (rs: BackgroundRun[]) =>
    JSON.stringify(
      rs.map((r) => [
        r.id,
        r.status,
        r.processed ?? 0,
        r.failed ?? 0,
        r.total ?? 0,
        r.summary ?? "",
        r.error ?? "",
        r.errorCode ?? "",
      ]),
    );

  const refreshRuns = useCallback(async () => {
    // Guardia de carrera: el intervalo dispara cada 2s sin esperar; si dos
    // polls se solapan y el viejo resuelve último, su snapshot rancio haría
    // flap (activo→quieto→activo) y cada flanco quieto refrescaba la página.
    const gen = ++pollGenRef.current;
    try {
      const next = await getActiveRunsAction();
      if (gen !== pollGenRef.current) return; // respuesta superada: descartar
      const key = runsKey(next);
      if (key !== lastKeyRef.current) {
        lastKeyRef.current = key;
        setRuns(next);
      }
    } catch {
      // Sin toast antes que sin página.
    }
  }, []);

  useEffect(() => {
    // Diferido: evita setState sincrónico en el efecto (cascada de renders).
    queueMicrotask(() => {
      void refreshRuns();
    });
  }, [refreshRuns]);

  const isStale = useCallback(
    (run: BackgroundRun) =>
      run.status === "running" && now - Date.parse(run.startedAt) > STALE_MS,
    [now],
  );
  const activeRuns = useMemo(
    () => runs.filter((r) => r.status === "running" && !isStale(r)),
    [runs, isStale],
  );

  useEffect(() => {
    if (!starting && activeRuns.length === 0) return;
    const t = setInterval(() => {
      setNow(Date.now());
      void refreshRuns();
    }, 2000);
    return () => clearInterval(t);
  }, [starting, activeRuns.length, refreshRuns]);

  const start = useCallback(
    async (action: () => Promise<BackgroundTaskResult>) => {
      setStarting(true);
      try {
        const r = await action();
        await refreshRuns();
        router.refresh();
        return r;
      } finally {
        setStarting(false);
      }
    },
    [router, refreshRuns],
  );

  const dismiss = useCallback((id: string) => {
    toast.close(id);
    knownToastIdsRef.current.delete(id);
    setDismissed((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      try {
        window.localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
      } catch {
        // Sin persistencia: igual se oculta en esta vista.
      }
      return next;
    });
  }, []);

  // Vimos actividad y se aquietó: refresca el server render UNA vez y solo
  // si la actividad cambió algo visible (snapshot al empezar vs al aquietar)
  // y con cooldown: sin esto, corridas largas/en flap disparan
  // router.refresh() en loop y toda la página parpadea con skeletons.
  const watchedRun = useRef(false);
  useEffect(() => {
    const busy = starting || activeRuns.length > 0;
    if (busy) {
      watchedRun.current = true;
      if (watchKeyRef.current === null) watchKeyRef.current = runsKey(runs);
      return;
    }
    if (watchedRun.current) {
      watchedRun.current = false;
      const changed = watchKeyRef.current !== runsKey(runs);
      watchKeyRef.current = null;
      if (changed && Date.now() - lastAutoRefreshRef.current > 15000) {
        lastAutoRefreshRef.current = Date.now();
        router.refresh();
      }
    }
  }, [starting, activeRuns.length, router, runs]);

  const isBusy = useCallback(
    (kind: string, scopeId?: string | null) =>
      !isCompatible(
        { kind, scopeId: scopeId ?? null },
        activeRuns.map((r) => ({ kind: r.kind, scopeKind: r.scopeKind, scopeId: r.scopeId, label: r.label })),
      ),
    [activeRuns],
  );

  const queue = useMemo(
    () => runs.filter((r) => !dismissed.has(r.id)),
    [runs, dismissed],
  );

  // Sincroniza corridas → toasts (id estable = run.id: add crea, update
  // refresca progreso sin resetear timers de forma agresiva, close al
  // descartar). Base UI apila solo (limit=3 en el Toaster); sin rotación
  // manual uno-por-uno.
  useEffect(() => {
    const known = knownToastIdsRef.current;
    const desired = new Map<string, BackgroundRun>();
    for (const r of queue) desired.set(r.id, r);

    for (const id of [...known]) {
      if (!desired.has(id)) {
        toast.close(id);
        known.delete(id);
      }
    }

    for (const [id, run] of desired) {
      const stale = isStale(run);
      const running = run.status === "running" && !stale;
      const veto = !running && isVetoRun(run);
      const succeeded = !running && run.status === "done" && !stale && !veto;
      const total = run.total ?? 0;
      const done = (run.processed ?? 0) + (run.failed ?? 0);
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

      if (running) {
        const options = {
          title: run.label,
          description: (
            <span className="flex flex-col gap-1.5">
              <span className="tabular-nums">
                {formatNumber(done)}/{formatNumber(total)} · {pct}%
                {run.failed > 0 ? ` · ${formatNumber(run.failed)} fallidos` : ""}
              </span>
              <span className="h-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary transition-[width] duration-700"
                  style={{ width: `${pct}%` }}
                />
              </span>
            </span>
          ),
          type: "loading" as const,
          timeout: 0,
          onClose: () => dismiss(id),
        };
        if (known.has(id)) toast.update(id, options);
        else {
          toast.add({ id, ...options });
          known.add(id);
        }
        continue;
      }

      const detail = succeeded
        ? run.summary
          ? truncate(run.summary, SUMMARY_MAX)
          : null
        : veto
          ? truncate(
              `${run.errorCode ? errorCodeMessage(run.errorCode) : "Omitido"}${run.summary ? ` · ${run.summary}` : ""}`,
              SUMMARY_MAX,
            )
          : truncate(
              run.error
                ? run.error
                : run.summary
                  ? `${run.summary}`
                  : "",
              SUMMARY_MAX,
            );
      const options = {
        title: succeeded
          ? `${run.label} listo`
          : veto
            ? (run.errorCode ? errorCodeMessage(run.errorCode) : "Omitido")
            : `${run.label} ${stale ? "interrumpido" : "con errores"}`,
        description: detail || undefined,
        type: succeeded ? ("success" as const) : veto ? ("warning" as const) : ("error" as const),
        timeout: succeeded ? AUTO_HIDE_MS : ERROR_HIDE_MS,
        priority: succeeded || veto ? ("low" as const) : ("high" as const),
        ...(succeeded
          ? {
              actionProps: {
                children: "Ver en Review",
                onClick: () => {
                  dismiss(id);
                  router.push("/review");
                },
              },
            }
          : null),
        onClose: () => dismiss(id),
      };
      if (known.has(id)) toast.update(id, options);
      else {
        toast.add({ id, ...options });
        known.add(id);
      }
    }
  }, [queue, isStale, dismiss, router]);

  return (
    <BackgroundCtx.Provider value={{ runs, activeRuns, starting, start, isBusy }}>
      {children}
    </BackgroundCtx.Provider>
  );
}
