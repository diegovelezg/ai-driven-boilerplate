// Decisión pura: ¿debe el login disparar sync ecommerce → BD?
// Sin dependencias server (testeable con node:test vía tsx, sin BD ni red).
import type { StoreConnections } from "@/lib/store";

export type LoginSyncReason =
  | "ok"
  | "shopify-sin-backend"
  | "sin-conexion"
  | "sin-supabase"
  | "run-en-curso";

export interface LoginSyncCheck {
  supabaseConfigured: boolean;
  hasRunningRun: boolean;
}

/** Condiciones para disparar sync tras un login exitoso (Medusa hoy, Shopify futuro). */
export function shouldSyncOnLogin(
  conn: Pick<StoreConnections, "platform" | "medusaUrl" | "medusaToken">,
  check: LoginSyncCheck,
): { sync: boolean; reason: LoginSyncReason } {
  // Shopify aún sin backend (ver settings-actions): solo Medusa sincroniza.
  if (conn.platform !== "medusa") return { sync: false, reason: "shopify-sin-backend" };
  if (!conn.medusaUrl || !conn.medusaToken) return { sync: false, reason: "sin-conexion" };
  if (!check.supabaseConfigured) return { sync: false, reason: "sin-supabase" };
  if (check.hasRunningRun) return { sync: false, reason: "run-en-curso" };
  return { sync: true, reason: "ok" };
}
