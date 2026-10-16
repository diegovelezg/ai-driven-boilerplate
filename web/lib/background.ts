// Corridas en segundo plano. Fuente única de verdad (SSOT) para la cinta de
// progreso global: cualquier trabajo de larga duración (enriquecimiento, sync,
// ...) registra aquí su estado y la UI lo muestra con un solo componente.
// Sin `server-only`: los scripts tsx (enrich-once, prospect-once) lo importan;
// ningún componente cliente lo importa en runtime (solo el tipo BackgroundRun).
import { getSupabase } from "@/lib/supabase";

export type RunStatus = "running" | "done" | "error";

export interface BackgroundRun {
  id: string;
  kind: string;
  label: string;
  status: RunStatus;
  total: number;
  processed: number;
  failed: number;
  current: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function mapRun(r: Record<string, unknown>): BackgroundRun {
  return {
    id: String(r.id),
    kind: (r.kind as string) ?? "",
    label: (r.label as string) ?? "",
    status: (r.status as RunStatus) ?? "running",
    total: Number(r.total ?? 0),
    processed: Number(r.processed ?? 0),
    failed: Number(r.failed ?? 0),
    current: (r.current as string) ?? null,
    summary: (r.summary as string) ?? null,
    error: (r.error as string) ?? null,
    startedAt: String(r.started_at ?? ""),
    finishedAt: (r.finished_at as string) ?? null,
  };
}

export async function getLatestRun(storeId: string): Promise<BackgroundRun | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from("background_runs")
    .select("*")
    .eq("store_id", storeId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Runs read: ${error.message}`);
  return data ? mapRun(data as Record<string, unknown>) : null;
}

export async function hasRunningRun(storeId: string): Promise<boolean> {
  const db = getSupabase();
  const { data, error } = await db
    .from("background_runs")
    .select("id")
    .eq("store_id", storeId)
    .eq("status", "running")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Runs read: ${error.message}`);
  return Boolean(data);
}

export async function startRun(
  storeId: string,
  kind: string,
  label: string,
  total: number,
): Promise<string> {
  const db = getSupabase();
  const { data, error } = await db
    .from("background_runs")
    .insert({ store_id: storeId, kind, label, total, status: "running" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Run insert: ${error?.message}`);
  return String(data.id);
}

/** Actualiza el progreso en vivo de una corrida. */
export async function advanceRun(
  runId: string,
  p: { processed: number; failed: number; current: string | null },
): Promise<void> {
  const db = getSupabase();
  await db
    .from("background_runs")
    .update({ current: p.current, processed: p.processed, failed: p.failed })
    .eq("id", runId);
}

/** Cierra una corrida con su resultado final. */
export async function finishRun(
  runId: string,
  p: {
    status: RunStatus;
    processed: number;
    failed: number;
    summary?: string | null;
    error?: string | null;
  },
): Promise<void> {
  const db = getSupabase();
  await db
    .from("background_runs")
    .update({
      status: p.status,
      processed: p.processed,
      failed: p.failed,
      summary: p.summary ?? null,
      error: p.error ?? null,
      current: null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
}
