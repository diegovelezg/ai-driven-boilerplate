// Solo server-side: usa service_role (bypassa RLS). Nunca importar en client components.
// (Sin `import "server-only"`: los tests `tsx --test` importan este módulo en
// node y `server-only` lanza fuera de React Server Components. La protección
// real contra fugas al browser es no serializar secretos: ver `toSafeConnections`.)
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local");
  }
  if (!cached) {
    cached = createClient(url, key, { auth: { persistSession: false } });
  }
  return cached;
}
