// Bootstrap compartido de los scripts `*-once.ts` (ejecución manual con tsx).
import { getSupabase } from "@/lib/supabase";

/** Resuelve la primera tienda (sin ecommerce). */
export async function resolveStoreId(): Promise<string | null> {
  const { data } = await getSupabase().from("sys_stores").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
  return (data?.id as string) ?? null;
}

/** Lee la primera tienda. Falla si no hay. */
export async function loadStoreId(): Promise<string> {
  const storeId = await resolveStoreId();
  if (!storeId) throw new Error("Sin tiendas en Supabase.");
  return storeId;
}

/** Catch final estándar: `<TAG> FAIL:` + exit 1. Uso: `main().catch((e) => fail("SCOUT", e))`. */
export function fail(tag: string, e: unknown): never {
  console.error(`${tag} FAIL:`, e instanceof Error ? e.message : e);
  process.exit(1);
}

/** Variante con service-role directo: primera tienda. */
export async function loadServiceStore() {
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: store } = await db.from("sys_stores").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!store) throw new Error("Sin stores.");
  return { db, storeId: (store as { id: string }).id as string };
}
