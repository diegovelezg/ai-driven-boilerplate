// Solo server (Server Components / Actions / Route Handlers). Nunca importar
// en client components. service_role (lib/supabase.ts) queda para workers.
import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseEnv } from "@/lib/supabase-browser";

export function isUserAuthConfigured(): boolean {
  try {
    supabaseEnv();
    return true;
  } catch {
    return false;
  }
}

/** Server-side con cookies (lee+escribe sesión). RLS por tenant aplica. */
export async function createServerSupabase() {
  const { url, anon } = supabaseEnv();
  const store = await cookies();
  return createServerClient(url, anon, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) {
          try {
            store.set(name, value, options);
          } catch {
            // Server Component: el proxy refresca la sesión.
          }
        }
      },
    },
  });
}
