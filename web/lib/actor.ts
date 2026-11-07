// Identidad para auditoría: email de la sesión Supabase.
// Mismo patrón que `resolveApprover` (review) y `closed_by` (inbox):
// `*_by` guarda email legible sin join; sin sesión resoluble (seed, jobs)
// queda null. Nunca inventar un nombre.
import { createServerSupabase } from "@/lib/supabase-server";

export async function resolveActor(): Promise<string | null> {
  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}
