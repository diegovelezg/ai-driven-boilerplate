// Bootstrap compartido de los scripts `*-once.ts` (ejecución manual con tsx).
// Centraliza lo que todos duplicaban: `resolveStoreId` inline (evita la cadena
// customers-db → sync → server-only, que rompe tsx), la lectura de
// `.data/connections.json` y el catch final con exit code.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";

/** resolveStoreId inline: evita la cadena customers-db → sync → server-only (rompe tsx). */
export async function resolveStoreId(medusaUrl: string): Promise<string | null> {
  const normalized = medusaUrl.trim().replace(/\/+$/, "").toLowerCase();
  const { data } = await getSupabase()
    .from("stores")
    .select("id")
    .eq("platform", "medusa")
    .eq("shop_url", normalized)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

/** Lee la conexión guardada y resuelve el store. Falla si no está sincronizado. */
export async function loadStoreId(): Promise<string> {
  const conn = JSON.parse(readFileSync(".data/connections.json", "utf-8"));
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) throw new Error("Tienda sin sincronizar en Supabase.");
  return storeId;
}

/** Catch final estándar: `<TAG> FAIL:` + exit 1. Uso: `main().catch((e) => fail("SCOUT", e))`. */
export function fail(tag: string, e: unknown): never {
  console.error(`${tag} FAIL:`, e instanceof Error ? e.message : e);
  process.exit(1);
}

/** Variante con service-role directo (calibración/perfilado): mismo lookup por `shop_url`. */
export async function loadServiceStore() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const medusaUrl = String(
    JSON.parse(readFileSync(".data/connections.json", "utf-8")).medusaUrl,
  ).replace(/\/+$/, "");
  const { data: store } = await db.from("stores").select("id").eq("shop_url", medusaUrl).maybeSingle();
  if (!store) throw new Error("Sin store para esta conexión.");
  return { db, storeId: store.id as string };
}
