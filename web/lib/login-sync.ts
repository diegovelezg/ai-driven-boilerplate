// Decisión pura: ¿debe el login disparar sync ecommerce → BD?
// Sin dependencias server (testeable con node:test vía tsx, sin BD ni red).
import { isConnectorSupported } from "@/lib/connectors";
import type { StoreConnections } from "@/lib/store";

export type LoginSyncReason =
  | "ok"
  /** @deprecated Alias legacy de `sin-backend` (tests/UI lo esperan para Shopify). */
  | "shopify-sin-backend"
  | "sin-backend"
  | "sin-conexion"
  | "sin-supabase"
  | "run-en-curso"
  | "sync-reciente";

/** Throttle entre syncs de login: el cron diario es el dueño del full.
 *  El login solo sincroniza si la tienda lleva >12h sin sync (5 users de un
 *  tenant espaciados = 1-2 fulls/día, no 5). Default 12h. */
export const LOGIN_SYNC_MIN_INTERVAL_MS = 12 * 60 * 60_000;

/** Condiciones para disparar sync tras un login exitoso (Medusa hoy, Shopify futuro). */
export function shouldSyncOnLogin(
  conn: Pick<StoreConnections, "platform" | "medusaUrl" | "medusaToken">,
  check: LoginSyncCheck,
): { sync: boolean; reason: LoginSyncReason } {
  // Solo sincronizan las plataformas con backend (hoy solo medusa).
  // `shopify-sin-backend` se conserva como alias legacy para no romper la UI.
  if (!isConnectorSupported(conn.platform)) {
    return {
      sync: false,
      reason: conn.platform === "shopify" ? "shopify-sin-backend" : "sin-backend",
    };
  }
  if (conn.platform !== "medusa") return { sync: false, reason: "sin-backend" };
  if (!conn.medusaUrl || !conn.medusaToken) return { sync: false, reason: "sin-conexion" };
  if (!check.supabaseConfigured) return { sync: false, reason: "sin-supabase" };
  if (check.hasRunningRun) return { sync: false, reason: "run-en-curso" };
  const last = check.lastSyncDoneAt ? Date.parse(check.lastSyncDoneAt) : NaN;
  if (check.lastSyncDoneAt != null && Number.isNaN(last)) {
    // Timestamp corrupto: fail-closed (morning igual corre; el cron cubre el full).
    return { sync: false, reason: "sync-reciente" };
  }
  if (!Number.isNaN(last)) {
    const minMs = check.minIntervalMs ?? LOGIN_SYNC_MIN_INTERVAL_MS;
    if (Date.now() - last < minMs) return { sync: false, reason: "sync-reciente" };
  }
  return { sync: true, reason: "ok" };
}

export interface LoginSyncCheck {
  supabaseConfigured: boolean;
  hasRunningRun: boolean;
  /** ISO del último sync `done` (null = nunca). Para throttle. */
  lastSyncDoneAt?: string | null;
  /** Antigüedad mínima entre syncs de login. Default 12h (LOGIN_SYNC_MIN_INTERVAL_MS). */
  minIntervalMs?: number;
}
