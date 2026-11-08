// Gate de esquema en runtime (Fase 2 DOOH): la fuente de verdad sigue en
// supabase/migrations/*.sql. Sonda por PostgREST las tablas del flujo
// comercial real: órdenes (IOs), inventario y CRM.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SchemaGap {
  relation: string;
  hint: string;
}

const REQUIRED_TABLES = [
  "sys_stores",
  "crm_companies",
  "crm_contacts",
  "inv_venues",
  "inv_screens",
  "inv_slots",
  "io_orders",
  "io_lines",
  "inv_bookings",
] as const;

export async function checkSchema(db: SupabaseClient): Promise<SchemaGap[]> {
  const gaps: SchemaGap[] = [];
  for (const t of REQUIRED_TABLES) {
    const { error } = await db.from(t).select("*", { count: "exact", head: true });
    if (error) gaps.push({ relation: `public.${t}`, hint: error.message });
  }
  return gaps;
}

export function schemaGapMessage(gaps: SchemaGap[]): string {
  const names = gaps.map((g) => g.relation).join(", ");
  return (
    `DB detrás del código: falta ${names}. ` +
    `Aplicar supabase/migrations en el contenedor supabase-db-* ` +
    `(aplicar supabase/migrations en el contenedor supabase-db-*` +
    ` y reiniciar la sub-app rest ` +
    `(schema-cache de PostgREST). Ver docs/coolify.md §4.`
  );
}
