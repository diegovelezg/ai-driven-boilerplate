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
import { Check, ListChecks, PenLine, Radar, RefreshCw, Send, TrendingUp, TriangleAlert, Wand2, X, type LucideIcon } from "lucide-react";
import { getActiveRunsAction } from "@/lib/background-actions";
import type { BackgroundRun } from "@/lib/background";
import { errorCodeMessage, isCompatible } from "@/lib/operations";
import { isJudgeVetoMessage } from "@/lib/single-audit";

export interface BackgroundTaskResult {
  ok: boolean;
  message: string;
  run: BackgroundRun | null;
}

interface BackgroundCtxValue {
  /** En curso + últimos terminados (la cinta los apila como chips). */
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

/** `null` fuera del provider (hosts sin cinta, p.ej. canvas del chat):
 *  el llamador usa su vía local en vez de romper. */
export function useBackgroundOrNull(): BackgroundCtxValue | null {
  return useContext(BackgroundCtx);
}

const ICONS: Record<string, LucideIcon> = {
  enrichment: Wand2,
  enrich_single: Wand2,
  sync: RefreshCw,
  scout: Radar,
  strategist: ListChecks,
  copywriter: PenLine,
  copywriter_single: PenLine,
  regenerate: RefreshCw,
  approve_batch: Check,
  dispatcher: Send,
  analyst: TrendingUp,
  prospect: Wand2,
};

const DISMISS_KEY = "background:dismissedRuns";
const LEGACY_DISMISS_KEY = "background:dismissedRun";
const STALE_MS = 20 * 60 * 1000;
const AUTO_HIDE_MS = 5000;
const ERROR_HIDE_MS = 15000;

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
export function isVetoRun(run: BackgroundRun): boolean {
  return run.errorCode === "judge_veto" || (run.summary ? isJudgeVetoMessage(run.summary) : false);
}

/**
 * Cinta global de procesos en segundo plano (SSOT, issue #16 Fase 2).
 * Apila un chip por corrida: activos con barra de progreso, terminados
 * con su `summary`/`error`. Un mismo componente sirve para cualquier
 * trabajo; solo cambia el `kind`/`scope` de cada corrida.
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
      // Sin cinta antes que sin página.
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
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
    setDismissed((prev) => {
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

  // Terminados: los archiva la rotación secuencial de abajo (uno visible N
  // segundos, luego el siguiente). Sin este relevo, los timers en masa los
  // apilaban y desaparecían todos juntos.

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
  // Sin apilar: uno a la vez. Activo manda; si no hay activo, se rota por los
  // terminados (uno visible N segundos, luego el siguiente).
  const [queueIdx, setQueueIdx] = useState(0);
  useEffect(() => {
    setQueueIdx(0);
  }, [queue.map((r) => r.id).join(",")]);
  useEffect(() => {
    const finished = queue.filter((r) => r.status !== "running" || isStale(r));
    if (activeRuns.length > 0 || finished.length === 0) return;
    const cur = finished[queueIdx % finished.length];
    const ok = cur.status === "done" && !isStale(cur) && !isVetoRun(cur);
    const t = setTimeout(() => {
      // Secuencia uno por uno: al vencer, se archiva el visible y aparece el
      // siguiente en vez de apilarse todos a la vez.
      dismiss(cur.id);
      setQueueIdx((i) => i + 1);
    }, ok ? AUTO_HIDE_MS : ERROR_HIDE_MS);
    return () => clearTimeout(t);
  }, [queue, queueIdx, activeRuns.length, isStale, dismiss]);
  const visible = useMemo(() => {
    if (queue.length === 0) return [];
    const active = queue.find((r) => r.status === "running" && !isStale(r));
    if (active) return [active];
    const finished = queue.filter((r) => r.status !== "running" || isStale(r));
    if (finished.length === 0) return [];
    return [finished[queueIdx % finished.length]];
  }, [queue, queueIdx, isStale]);

  return (
    <BackgroundCtx.Provider value={{ runs, activeRuns, starting, start, isBusy }}>
      {children}
      {visible.length > 0 && (
        <div className="fixed inset-x-0 top-0 z-50 flex flex-col">
          {visible.map((run) => (
            <RunChip key={run.id} run={run} stale={isStale(run)} onDismiss={() => dismiss(run.id)} />
          ))}
        </div>
      )}
    </BackgroundCtx.Provider>
  );
}

function RunChip({ run, stale, onDismiss }: { run: BackgroundRun; stale: boolean; onDismiss: () => void }) {
  const running = run.status === "running" && !stale;
  const Icon = ICONS[run.kind] || Wand2;
  const total = run.total ?? 0;
  const done = (run.processed ?? 0) + (run.failed ?? 0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  if (running) {
    return (
      <div className="relative h-9 overflow-hidden border-b border-primary/30 bg-primary/10 text-foreground backdrop-blur">
        <div
          className="absolute inset-y-0 left-0 bg-primary/15 transition-[width] duration-700"
          style={{ width: `${pct}%` }}
        />
        <div className="pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-[enrich-sheen_1.6s_linear_infinite] bg-gradient-to-r from-transparent via-primary/25 to-transparent" />
        <div className="relative flex h-full items-center justify-center gap-2 px-10 text-xs font-medium tabular-nums">
          <Icon className="size-3.5 animate-pulse text-primary" aria-hidden />
          {run.label}… {done}/{total}
          {run.failed > 0 && <span className="text-destructive">· {run.failed} fallidos</span>}
        </div>
      </div>
    );
  }

  const veto = isVetoRun(run);
  const succeeded = run.status === "done" && !stale && !veto;
  return (
    <div
      className={`relative flex h-9 items-center justify-center gap-2 border-b px-10 text-xs font-medium backdrop-blur ${
        succeeded
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : veto
            ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            : "border-destructive/30 bg-destructive/10 text-destructive"
      }`}
    >
      {succeeded ? (
        <>
          <Check className="size-3.5" aria-hidden />
          {run.label} listo{run.summary ? ` · ${run.summary}` : ""}
        </>
      ) : veto ? (
        <>
          <TriangleAlert className="size-3.5" aria-hidden />
          {run.errorCode ? errorCodeMessage(run.errorCode) : "Omitido"}
          {run.summary ? ` · ${run.summary}` : ""}
        </>
      ) : (
        <>
          <TriangleAlert className="size-3.5" aria-hidden />
          {run.label} {stale ? "interrumpido" : "con errores"}
          {run.error ? ` · ${run.error}` : run.summary ? ` · ${run.summary}` : ""}
        </>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Cerrar"
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 transition-colors hover:bg-foreground/10"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
