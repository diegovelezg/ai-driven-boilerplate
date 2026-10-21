// Gate de esquema en runtime (deuda 2026-10-21: la web se desplegó 9
// migraciones por delante de la DB prod y el sync falló con
// "Could not find the table 'public.products' in the schema cache").
// Sonda por PostgREST (no por information_schema, que rest no expone):
// si la tabla/columna no existe O el schema-cache de rest está viejo, el
// error es el mismo que ve el código real. No crea ni migra nada: solo
// diagnostica. La fuente de verdad sigue en supabase/migrations/*.sql y
// el que aplica es scripts/retain-apply.sh (ver docs/coolify.md §4).
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SchemaGap {
  relation: string;
  hint: string;
}

const REQUIRED_TABLES = [
  "products",
  "product_stats",
  "item_content",
  "customer_predictions",
  "background_runs",
] as const;

const REQUIRED_COLUMNS = [
  { table: "store_profiles", column: "metadata_map" },
  { table: "store_profiles", column: "brain_json" },
] as const;

export async function checkSchema(db: SupabaseClient): Promise<SchemaGap[]> {
  const gaps: SchemaGap[] = [];
  for (const t of REQUIRED_TABLES) {
    const { error } = await db.from(t).select("*", { count: "exact", head: true });
    if (error) gaps.push({ relation: `public.${t}`, hint: error.message });
  }
  for (const { table, column } of REQUIRED_COLUMNS) {
    const { error } = await db.from(table).select(column, { count: "exact", head: true });
    if (error) gaps.push({ relation: `public.${table}.${column}`, hint: error.message });
  }
  return gaps;
}

export function schemaGapMessage(gaps: SchemaGap[]): string {
  const names = gaps.map((g) => g.relation).join(", ");
  return (
    `DB detrás del código: falta ${names}. ` +
    `Aplicar supabase/migrations en el contenedor supabase-db-* ` +
    `(DB_CONTAINER=... ./scripts/retain-apply.sh schema) y reiniciar la sub-app rest ` +
    `(schema-cache de PostgREST). Ver docs/coolify.md §4.`
  );
}
