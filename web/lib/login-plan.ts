// Cableado del login multi-tenant (wiring `storeId → readConnections`).
// Módulo puro e importable en node (sin `next/server`, sin Supabase): la
// producción inyecta las deps reales, los tests inyectan mocks y asertan
// que `readConnections` recibe el storeId de la membresía (caso explícito)
// vs. sin args (legacy `null`). Extraído de `auth-actions` para cerrar el
// pendiente de regresión silenciosa: si alguien rompe el cableado, este test
// falla en vez de volver al bug en prod.
import { shouldSyncOnLogin, type LoginSyncReason } from "@/lib/login-sync";
import type { ConnectorPlatform } from "@/lib/connectors/types";

export interface LoginPlanConn {
  platform: ConnectorPlatform;
  medusaUrl: string;
  medusaToken: string;
  medusaVersion?: string;
}

export interface LoginPlanDeps {
  readConnections: (storeId?: string | null) => Promise<LoginPlanConn>;
  resolveStoreId: (url: string) => Promise<string | null>;
  hasRunningRun: (storeId: string) => Promise<boolean>;
  getLastFinishedAt: (storeId: string, kind: string) => Promise<string | null>;
  ensureStore: (url: string, token: string) => Promise<string | null>;
  supabaseConfigured: boolean;
}

export interface LoginPlan {
  conn: LoginPlanConn;
  probeStoreId: string | null;
  running: boolean;
  lastSyncDoneAt: string | null;
  decision: { sync: boolean; reason: LoginSyncReason };
  storeId: string | null;
  /** Motivo de omisión temprana (reconciliación), si aplica. */
  omitReason?: string;
}

/** Resuelve el plan de sync del login sin efectos (sin `after`, sin runs). */
export async function planLoginSync(
  targetStoreId: string | null | undefined,
  deps: LoginPlanDeps,
): Promise<LoginPlan> {
  const conn = await deps.readConnections(targetStoreId ?? undefined);
  // Reconciliación anti split-brain (solo rama explícita).
  if (targetStoreId && conn.medusaUrl && deps.supabaseConfigured) {
    const resolved = await deps.resolveStoreId(conn.medusaUrl).catch(() => null);
    if (resolved && resolved !== targetStoreId) {
      const running = await deps.hasRunningRun(targetStoreId).catch(() => false);
      const lastSyncDoneAt = await deps
        .getLastFinishedAt(targetStoreId, "sync")
        .catch(() => null);
      const decision = shouldSyncOnLogin(conn, {
        supabaseConfigured: deps.supabaseConfigured,
        hasRunningRun: running,
        lastSyncDoneAt,
      });
      return {
        conn,
        probeStoreId: targetStoreId,
        running,
        lastSyncDoneAt,
        decision,
        storeId: null,
        omitReason: `url-resuelve-a-otra-tienda ${resolved}`,
      };
    }
  }
  const probeStoreId =
    targetStoreId ?? (deps.supabaseConfigured ? await deps.resolveStoreId(conn.medusaUrl).catch(() => null) : null);
  const running = probeStoreId ? await deps.hasRunningRun(probeStoreId).catch(() => false) : false;
  const lastSyncDoneAt = probeStoreId
    ? await deps.getLastFinishedAt(probeStoreId, "sync").catch(() => null)
    : null;
  const decision = shouldSyncOnLogin(conn, {
    supabaseConfigured: deps.supabaseConfigured,
    hasRunningRun: running,
    lastSyncDoneAt,
  });
  const storeId =
    probeStoreId ?? (decision.sync ? await deps.ensureStore(conn.medusaUrl, conn.medusaToken).catch(() => null) : null);
  return { conn, probeStoreId, running, lastSyncDoneAt, decision, storeId };
}
