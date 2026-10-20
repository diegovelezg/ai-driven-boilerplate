// Catálogo por tenant (lectura para el engine + override manual de activo).
// El sync escribe platform_status; el trigger SQL decide is_active:
// override ?? plataforma. Esto solo escribe el override (null = seguir plataforma).
import { getSupabase } from "@/lib/supabase";

export interface TenantProduct {
  id: string;
  title: string;
  platform_status: string | null;
  is_active: boolean;
  is_active_override: boolean | null;
  variants_count: number;
}

/** Lista productos del tenant (activos primero, luego por título). */
export async function listProducts(storeId: string): Promise<TenantProduct[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("products")
    .select("id,title,platform_status,is_active,is_active_override,variants_json")
    .eq("store_id", storeId)
    .order("is_active", { ascending: false })
    .order("title", { ascending: true })
    .limit(500);
  if (error) throw new Error(`Products read: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    title: String(r.title ?? ""),
    platform_status: (r.platform_status as string | null) ?? null,
    is_active: r.is_active === true,
    is_active_override: (r.is_active_override as boolean | null) ?? null,
    variants_count: Array.isArray(r.variants_json)
      ? (r.variants_json as unknown[]).length
      : 0,
  }));
}

/** Fija o libera el override manual. active=null → vuelve a seguir a plataforma. */
export async function setProductActiveOverride(
  storeId: string,
  productId: string,
  active: boolean | null,
): Promise<void> {
  const db = getSupabase();
  // Con .select se verifica fila afectada: sin ella el update fantasma (0 filas)
  // parecía éxito y el toast mentía.
  const { data, error } = await db
    .from("products")
    .update({ is_active_override: active })
    .eq("id", productId)
    .eq("store_id", storeId)
    .select("id");
  if (error) throw new Error(`Products update: ${error.message}`);
  if ((data ?? []).length === 0) throw new Error("Producto no encontrado en esta tienda.");
}
