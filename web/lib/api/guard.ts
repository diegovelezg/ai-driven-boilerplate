// Guard compartido de las rutas `app/api/customers/[id]/*`.
// Centraliza el bloque que las 6 rutas duplicaban: exigir Supabase
// configurado y extraer `:id` de los params (Next 16: promesa).
import { isSupabaseConfigured } from "@/lib/supabase";

/** Valida Supabase + `:id`. Devuelve el id o un `Response` de error listo para retornar. */
export async function resolveRouteCustomerId(
  params: Promise<{ id: string }>,
): Promise<string | Response> {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }
  const { id } = await params;
  if (!id) return Response.json({ error: "Falta id." }, { status: 400 });
  return id;
}
