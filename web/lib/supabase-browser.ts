// Solo browser (client components). Sin imports server: este módulo es seguro
// para el bundle cliente.
import { createBrowserClient } from "@supabase/ssr";

export function supabaseEnv(): { url: string; anon: string } {
  // NEXT_PUBLIC_* primero: son las únicas inlined en el bundle browser.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("Falta NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY en .env.local");
  }
  return { url, anon };
}

/** Client components (sesión en browser, sin secretos). */
export function createBrowserSupabase() {
  const { url, anon } = supabaseEnv();
  return createBrowserClient(url, anon);
}
